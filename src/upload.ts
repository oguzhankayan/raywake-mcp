import { constants, type Stats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MB = 1024 * 1024;
// Mirrors the gateway's upload allowlist; the gateway stays authoritative.
export const UPLOAD_LIMITS = {
  'image/jpeg': 25 * MB, 'image/png': 25 * MB, 'image/webp': 25 * MB,
  'video/mp4': 200 * MB, 'video/quicktime': 200 * MB, 'video/webm': 100 * MB,
  'audio/mpeg': 50 * MB, 'audio/wav': 50 * MB,
} as const;
export type UploadType = keyof typeof UPLOAD_LIMITS;
export const LIMITS_TEXT = 'JPEG/PNG/WebP up to 25 MB, MP4/MOV up to 200 MB, WebM up to 100 MB, MP3/WAV up to 50 MB';
export const ROOTS_ENV = 'RAYWAKE_UPLOAD_ROOTS';

// A file is opened only when its name already says it is an accepted media type.
const EXTENSIONS: Record<string, UploadType[]> = {
  '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.jpe': ['image/jpeg'], '.jfif': ['image/jpeg'],
  '.png': ['image/png'], '.webp': ['image/webp'],
  '.mp4': ['video/mp4', 'video/quicktime'], '.m4v': ['video/mp4', 'video/quicktime'],
  '.mov': ['video/quicktime', 'video/mp4'], '.qt': ['video/quicktime', 'video/mp4'],
  '.webm': ['video/webm'], '.mp3': ['audio/mpeg'], '.wav': ['audio/wav'],
};

export class UploadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

const ascii = (bytes: Buffer, start: number, end: number) => bytes.subarray(start, end).toString('latin1');
// ISO media brands that are not a video the gateway accepts (audio-only MP4, HEIF/AVIF stills).
const NOT_VIDEO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis', 'crx ', 'jp2 ', 'jpx ']);
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** Content type from the file's own first bytes; the extension only breaks MOV/MP4 ties. */
export function detectType(head: Buffer, extension = ''): UploadType | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF') {
    if (ascii(head, 8, 12) === 'WEBP') return 'image/webp';
    if (ascii(head, 8, 12) === 'WAVE') return 'audio/wav';
    return undefined;
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML: WebM declares DocType "webm"; other Matroska files are not accepted.
    return ascii(head, 4, Math.min(head.length, 64)).includes('webm') ? 'video/webm' : undefined;
  }
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (NOT_VIDEO_BRANDS.has(brand)) return undefined;
    return 'video/mp4';
  }
  if (head.length >= 8 && QUICKTIME_ATOMS.has(ascii(head, 4, 8)) && ['.mov', '.qt'].includes(extension)) return 'video/quicktime';
  if (head.length >= 3 && ascii(head, 0, 3) === 'ID3') return 'audio/mpeg';
  // MPEG audio frame sync with a defined layer (excludes ADTS AAC, whose layer bits are 00).
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0 && (head[1] & 0x18) !== 0x08) return 'audio/mpeg';
  return undefined;
}

export interface PathPolicy {
  /** Replaces the default roots (home folder and working folder) when set. */
  roots?: string[];
  home?: string;
  cwd?: string;
}

/** Parse RAYWAKE_UPLOAD_ROOTS: absolute folders separated by the platform path delimiter. */
export function parseRoots(value: string | undefined, home = homedir()): string[] | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return value.split(path.delimiter).map(entry => entry.trim()).filter(Boolean)
    .map(entry => expandHome(entry, home)).filter(entry => path.isAbsolute(entry)).map(entry => path.resolve(entry));
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

function within(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative;
}

function defaultRoots(home: string, cwd: string): string[] {
  const roots = [home];
  // A client may start the server in "/" or another folder above home; that must not open the whole disk.
  if (path.parse(cwd).root !== cwd && within(cwd, home) === undefined) roots.push(cwd);
  return roots;
}

async function realRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map(root => realpath(root).catch(() => undefined)));
  return [...new Set([...roots, ...resolved.filter((root): root is string => !!root)])];
}

/** Inside at least one root, and inside no hidden folder as seen from any root that contains it. */
function allowed(target: string, roots: string[]): boolean {
  const relatives = roots.map(root => within(root, target)).filter((relative): relative is string => relative !== undefined);
  return relatives.length > 0 && !relatives.some(relative => relative.split(/[\\/]/).some(segment => segment.startsWith('.')));
}

function notAllowed(rootsText: string): UploadError {
  return new UploadError('path_not_allowed', `This file is not in a folder Raywake may read (${rootsText}). Hidden and settings folders such as .ssh or .config are never read. Ask the user to move the file into an allowed folder, or to set ${ROOTS_ENV} in the MCP server configuration.`);
}

export interface CheckedFile {
  realPath: string;
  name: string;
  extension: string;
  stats: Stats;
}

/** Resolve and vet a path without opening the file. */
export async function checkPath(raw: string, policy: PathPolicy = {}): Promise<CheckedFile> {
  const home = path.resolve(policy.home ?? homedir());
  const cwd = path.resolve(policy.cwd ?? process.cwd());
  let value = raw.trim();
  if (/^file:\/\//i.test(value)) {
    try { value = fileURLToPath(value); }
    catch { throw new UploadError('not_found', 'This file:// address is not a valid local path. Pass the file path instead.'); }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^data:/i.test(value)) {
    throw new UploadError('not_a_local_file', 'upload_file takes a path to a file on this computer, not a link or data URI.');
  }
  if (!value || value.includes('\0')) throw new UploadError('not_found', 'Pass the path of one file on this computer.');
  const target = path.resolve(cwd, expandHome(value, home));
  const configured = policy.roots !== undefined;
  const roots = await realRoots(configured ? policy.roots! : defaultRoots(home, cwd));
  const rootsText = configured ? `${ROOTS_ENV}: ${policy.roots!.join(path.delimiter) || 'none'}` : 'the home folder and the working folder';
  const extension = path.extname(target).toLowerCase();
  if (!EXTENSIONS[extension]) throw unsupported();
  // Refuse before touching the disk, so paths outside the roots are not even probed for existence.
  if (!allowed(target, roots)) throw notAllowed(rootsText);
  let realPath: string;
  try { realPath = await realpath(target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new UploadError('not_readable', 'This file cannot be read: permission denied.');
    throw new UploadError('not_found', 'File not found. Check the exact path, including the folder and extension.');
  }
  // Symlinks are judged by where they lead.
  if (!allowed(realPath, roots)) throw notAllowed(rootsText);
  const realExtension = path.extname(realPath).toLowerCase();
  if (!EXTENSIONS[realExtension]) throw unsupported();
  const stats = await stat(realPath).catch(() => { throw new UploadError('not_found', 'File not found.'); });
  if (!stats.isFile()) throw new UploadError('not_a_file', 'This path is not a regular file. Pass one image, video or audio file.');
  return { realPath, name: path.basename(target), extension: realExtension, stats };
}

export function unsupported(): UploadError {
  return new UploadError('unsupported_type', `Unsupported file type. Accepted: ${LIMITS_TEXT}. Do not convert or re-encode the user's file without asking them.`);
}

export function tooLarge(type: UploadType, size: number): UploadError {
  const limit = UPLOAD_LIMITS[type] / MB;
  return new UploadError('too_large', `This file is too large: ${(size / MB).toFixed(1)} MB, and ${type} files can be at most ${limit} MB. Do not shrink, trim or re-encode the user's file without asking them.`);
}

export interface OpenedFile extends CheckedFile {
  handle: FileHandle;
  contentType: UploadType;
  size: number;
}

/** Open the vetted file, confirm it is the same file, and identify it from its first bytes. */
export async function openMedia(raw: string, policy: PathPolicy = {}): Promise<OpenedFile> {
  const checked = await checkPath(raw, policy);
  const size = checked.stats.size;
  if (size < 1) throw new UploadError('empty_file', 'This file is empty.');
  // Reject on size before reading anything when no accepted type could hold it.
  const candidates = EXTENSIONS[checked.extension];
  if (size > Math.max(...Object.values(UPLOAD_LIMITS))) throw tooLarge(candidates[0], size);
  let handle: FileHandle;
  try { handle = await open(checked.realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw new UploadError('not_readable', 'This file cannot be opened for reading.'); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== checked.stats.ino || opened.dev !== checked.stats.dev || opened.size !== size) {
      throw new UploadError('file_changed', 'The file changed while it was being checked. Try again once it is saved.');
    }
    const head = Buffer.alloc(Math.min(64, size));
    await handle.read(head, 0, head.length, 0);
    const contentType = detectType(head, checked.extension);
    if (!contentType) throw unsupported();
    if (size > UPLOAD_LIMITS[contentType]) throw tooLarge(contentType, size);
    return { ...checked, handle, contentType, size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function localHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/** Stream exactly `size` bytes of the file to a presigned PUT URL. Resolves with the HTTP status. */
export function putFile(url: URL, file: OpenedFile, options: { idleMs?: number; signal?: AbortSignal } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let status: number | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (status !== undefined) resolve(status);
      else reject(error ?? new Error('Upload ended without a response.'));
    };
    const request = send(url, {
      method: 'PUT',
      // Both headers are part of the signature: the bytes must be exactly this type and length.
      headers: { 'Content-Type': file.contentType, 'Content-Length': String(file.size) },
      signal: options.signal,
    }, (response: IncomingMessage) => {
      status = response.statusCode ?? 0;
      response.resume();
      response.on('end', () => finish());
      response.on('error', error => finish(error));
    });
    request.setTimeout(options.idleMs ?? 60_000, () => request.destroy(new Error('Upload stalled.')));
    request.on('error', error => finish(error));
    const stream = file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false, highWaterMark: 1024 * 1024 });
    stream.on('error', error => request.destroy(error));
    stream.pipe(request);
  });
}
