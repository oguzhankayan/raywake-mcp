import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RaywakeClient, RaywakeError } from '../src/client.js';
import { PLAYBOOK } from '../src/playbook.js';
import { createMcpServer } from '../src/server.js';
import { detectType, parseRoots } from '../src/upload.js';

// Captured before tests/setup.ts stubs fetch: these tests talk only to their own 127.0.0.1 server.
const localFetch = globalThis.fetch;
const MB = 1024 * 1024;
const PROVIDERS = /\b(fal|fal-ai|wiro|eachlabs|higgsfield|r2|cloudflare|s3|amazon|aws|backblaze|gcs)\b/i;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body bytes')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]);
const box = (type: string, brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(type + brand, 'latin1'), Buffer.alloc(12)]);
const riff = (form: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from(form), Buffer.alloc(16)]);
const ebml = (doc: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from(doc), Buffer.alloc(16)]);

interface Reservation { id: string; contentType: string; size: number; received?: number; chunks?: number; sha?: string; uploaded?: boolean }
const state = {
  reservations: new Map<string, Reservation>(),
  requests: [] as string[],
  reserveStatus: 0, reserveBody: '', putFailures: 0, completeStatus: 0, fileUrl: '' as string,
  storage: [] as unknown[],
  pauseAfterFirstChunk: false, midUploadArrayBuffers: 0,
};
let server: Server;
let base = '';
let root = '';
let home = '';
let cwd = '';
let outside = '';

function json(res: import('node:http').ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname.replace(/[0-9a-f-]{36}/, ':id')}`);
    if (url.pathname.startsWith('/put/')) {
      // Stands in for the presigned PUT: the signature covers Content-Type and the exact Content-Length.
      const reservation = state.reservations.get(url.pathname.slice(5));
      if (req.method !== 'PUT' || !reservation || req.headers['content-type'] !== reservation.contentType ||
        req.headers['content-length'] !== String(reservation.size) || req.headers.authorization) {
        req.resume();
        return json(res, 403, { error: 'SignatureDoesNotMatch' });
      }
      const hash = createHash('sha256');
      let received = 0;
      let chunks = 0;
      for await (const chunk of req) {
        received += chunk.length; chunks++; hash.update(chunk);
        if (state.pauseAfterFirstChunk && chunks === 1) {
          // Stop reading: backpressure must hold the sender to a few buffered chunks, not the whole file.
          await delay(300);
          state.midUploadArrayBuffers = process.memoryUsage().arrayBuffers;
        }
      }
      if (state.putFailures > 0) { state.putFailures--; return json(res, 500, {}); }
      if (received !== reservation.size) return json(res, 400, { error: 'IncompleteBody' });
      Object.assign(reservation, { received, chunks, sha: hash.digest('hex'), uploaded: true });
      res.writeHead(200);
      return res.end();
    }
    if (req.headers.authorization !== 'Bearer dummy-upload-key') return json(res, 401, {});
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST' && url.pathname === '/v1/media-assets') {
      if (state.reserveStatus) return json(res, state.reserveStatus, { detail: state.reserveBody });
      const { content_type, size_bytes } = JSON.parse(body);
      const id = randomUUID();
      state.reservations.set(id, { id, contentType: content_type, size: size_bytes });
      return json(res, 200, { id, upload_url: `${base}/put/${id}`, content_type, size_bytes, expires_at: new Date(Date.now() + 1800_000).toISOString() });
    }
    const complete = url.pathname.match(/^\/v1\/media-assets\/([0-9a-f-]{36})\/complete$/);
    if (req.method === 'POST' && complete) {
      if (state.completeStatus) return json(res, state.completeStatus, { detail: 'nope' });
      const reservation = state.reservations.get(complete[1]);
      if (!reservation) return json(res, 404, { detail: 'Media asset not found.' });
      if (!reservation.uploaded) return json(res, 409, { detail: 'Upload has not completed.' });
      return json(res, 200, { id: reservation.id, url: state.fileUrl || `${base}/files/${reservation.id}?e=1&s=sig`,
        content_type: reservation.contentType, size_bytes: reservation.size, retention_expires_at: '2026-12-11T00:00:00Z' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/storage') {
      return json(res, 200, { totals: {}, items: state.storage, has_more: false });
    }
    json(res, 404, { detail: 'Unexpected mock route' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  root = await mkdtemp(path.join(tmpdir(), 'raywake-upload-'));
  home = path.join(root, 'home');
  cwd = path.join(home, 'project');
  outside = path.join(root, 'outside');
  for (const dir of [cwd, outside, path.join(home, 'Pictures'), path.join(home, '.ssh'), path.join(home, '.aws'),
    path.join(home, '.config'), path.join(home, 'folder.png')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, 'Pictures', 'product.png'), PNG);
  await writeFile(path.join(home, 'Pictures', 'actually-jpeg.png'), JPEG);
  await writeFile(path.join(cwd, 'local.jpg'), JPEG);
  await writeFile(path.join(home, 'Pictures', 'notes.txt'), 'secret');
  await writeFile(path.join(home, 'Pictures', 'fake.jpg'), 'not an image at all');
  await writeFile(path.join(home, 'Pictures', 'empty.png'), '');
  await writeFile(path.join(home, '.ssh', 'id.png'), PNG);
  await writeFile(path.join(home, '.aws', 'x.jpg'), JPEG);
  await writeFile(path.join(home, '.config', 'x.png'), PNG);
  await writeFile(path.join(outside, 'elsewhere.png'), PNG);
  await symlink(path.join(outside, 'elsewhere.png'), path.join(home, 'Pictures', 'link-out.png'));
  await symlink(path.join(home, '.ssh', 'id.png'), path.join(home, 'Pictures', 'link-ssh.png'));
  await symlink(path.join(home, 'Pictures', 'notes.txt'), path.join(home, 'Pictures', 'link-notes.png'));
  await symlink(path.join(home, 'Pictures', 'product.png'), path.join(home, 'Pictures', 'link-in.png'));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  Object.assign(state, { reserveStatus: 0, reserveBody: '', putFailures: 0, completeStatus: 0, fileUrl: '', storage: [], pauseAfterFirstChunk: false });
  state.requests.length = 0;
});

function client(options: { uploadRoots?: string[]; cwd?: string } = {}) {
  return new RaywakeClient({ apiKey: 'dummy-upload-key', baseUrl: base, fetch: localFetch, home, cwd: options.cwd ?? cwd, uploadRoots: options.uploadRoots });
}
async function failure(promise: Promise<unknown>): Promise<RaywakeError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(RaywakeError); return error as RaywakeError; }
  throw new Error('expected an error');
}
const messages: string[] = [];
async function expectCode(promise: Promise<unknown>, code: string, network = false) {
  const error = await failure(promise);
  messages.push(error.message);
  expect(error.details.error_code).toBe(code);
  expect(String(error)).not.toContain('dummy-upload-key');
  if (!network) expect(state.requests).toEqual([]);
  return error;
}

describe('content type detection', () => {
  it.each([
    [PNG, '.png', 'image/png'], [JPEG, '.jpg', 'image/jpeg'], [riff('WEBP'), '.webp', 'image/webp'],
    [riff('WAVE'), '.wav', 'audio/wav'], [Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1'), '.mp3', 'audio/mpeg'],
    [Buffer.from([0xff, 0xfb, 0x90, 0x64]), '.mp3', 'audio/mpeg'], [box('ftyp', 'isom'), '.mp4', 'video/mp4'],
    [box('ftyp', 'qt  '), '.mov', 'video/quicktime'], [box('ftyp', 'mp42'), '.mov', 'video/mp4'],
    [box('moov', ''), '.mov', 'video/quicktime'], [ebml('webm'), '.webm', 'video/webm'],
  ])('detects %#', (head, extension, type) => expect(detectType(head as Buffer, extension as string)).toBe(type));
  it.each([
    [ebml('matroska'), '.webm'], [box('ftyp', 'M4A '), '.mp4'], [box('ftyp', 'heic'), '.mp4'], [box('moov', ''), '.mp4'],
    [Buffer.from([0xff, 0xf1, 0x50, 0x80]), '.mp3'], [riff('AVI '), '.wav'], [Buffer.from('GIF89a'), '.png'], [Buffer.from('hello'), '.jpg'],
  ])('rejects lookalikes %#', (head, extension) => expect(detectType(head as Buffer, extension as string)).toBeUndefined());
});

describe('upload_file happy path', () => {
  it('reserves, streams the unchanged bytes with the signed type and length, completes and returns the owned url', async () => {
    const result = await client().uploadFile('~/Pictures/product.png');
    expect(result).toMatchObject({ kind: 'image', content_type: 'image/png', size_bytes: PNG.length, file_name: 'product.png',
      kept_until: '2026-12-11T00:00:00Z', use: expect.stringContaining('then quote') });
    expect(result.url).toMatch(new RegExp(`^${base}/files/[0-9a-f-]{36}\\?`));
    const reservation = state.reservations.get(result.asset_id)!;
    expect(reservation.sha).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(state.requests).toEqual(['POST /v1/media-assets', 'PUT /put/:id', 'POST /v1/media-assets/:id/complete']);
  });
  it('trusts the file signature over its extension and accepts paths relative to the working folder and symlinks inside it', async () => {
    expect(await client().uploadFile(path.join(home, 'Pictures', 'actually-jpeg.png'))).toMatchObject({ content_type: 'image/jpeg' });
    expect(await client().uploadFile('local.jpg')).toMatchObject({ content_type: 'image/jpeg', file_name: 'local.jpg' });
    expect(await client().uploadFile(`file://${path.join(home, 'Pictures', 'link-in.png')}`)).toMatchObject({ content_type: 'image/png' });
  });
  it('retries the PUT once on the same reservation after a server error', async () => {
    state.putFailures = 1;
    const result = await client().uploadFile('~/Pictures/product.png');
    expect(result.content_type).toBe('image/png');
    expect(state.requests.filter(r => r.startsWith('PUT'))).toHaveLength(2);
    expect(state.requests.filter(r => r === 'POST /v1/media-assets')).toHaveLength(1);
  });
  it('the fake PUT target rejects a different type or length, as the signed link does', async () => {
    const id = randomUUID();
    state.reservations.set(id, { id, contentType: 'image/png', size: 10 });
    const put = (headers: Record<string, string>, body: string) => new Promise<number>((resolve, reject) => {
      const req = request(`${base}/put/${id}`, { method: 'PUT', headers }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(body);
    });
    expect(await put({ 'Content-Type': 'image/jpeg', 'Content-Length': '10' }, '0123456789')).toBe(403);
    expect(await put({ 'Content-Type': 'image/png', 'Content-Length': '9' }, '012345678')).toBe(403);
  });
  it('streams a 200 MB video without loading it into memory', async () => {
    const file = path.join(home, 'Pictures', 'large.mp4');
    await writeFile(file, box('ftyp', 'isom'));
    await truncate(file, 200 * MB); // sparse: no 200 MB fixture on disk or in git
    state.pauseAfterFirstChunk = true;
    const before = process.memoryUsage().arrayBuffers;
    const result = await client().uploadFile(file);
    const reservation = state.reservations.get(result.asset_id)!;
    expect(result).toMatchObject({ content_type: 'video/mp4', size_bytes: 200 * MB });
    expect(reservation.received).toBe(200 * MB);
    expect(reservation.chunks).toBeGreaterThan(50);
    expect(state.midUploadArrayBuffers - before).toBeLessThan(32 * MB);
    await rm(file);
  }, 60_000);
});

describe('upload_file errors the assistant can act on', () => {
  it('not found', () => expectCode(client().uploadFile('~/Pictures/missing.png'), 'not_found'));
  it('a link instead of a path', () => expectCode(client().uploadFile('https://example.com/a.png'), 'not_a_local_file'));
  it('a data URI instead of a path', () => expectCode(client().uploadFile('data:image/png;base64,AAAA'), 'not_a_local_file'));
  it.each(['notes.txt', 'fake.jpg', 'link-notes.png'])('wrong type %s', name =>
    expectCode(client().uploadFile(path.join(home, 'Pictures', name)), 'unsupported_type'));
  it('a folder', () => expectCode(client().uploadFile('~/folder.png'), 'not_a_file'));
  it('an empty file', () => expectCode(client().uploadFile('~/Pictures/empty.png'), 'empty_file'));
  it('too large for its type, before any network call', async () => {
    const image = path.join(home, 'Pictures', 'huge.png');
    await writeFile(image, PNG);
    await truncate(image, 26 * MB);
    const error = await expectCode(client().uploadFile(image), 'too_large');
    expect(error.message).toContain('25 MB');
    const video = path.join(home, 'Pictures', 'huge.webm');
    await writeFile(video, ebml('webm'));
    await truncate(video, 101 * MB);
    expect((await expectCode(client().uploadFile(video), 'too_large')).message).toContain('100 MB');
    const any = path.join(home, 'Pictures', 'huge.mov');
    await writeFile(any, box('ftyp', 'qt  '));
    await truncate(any, 201 * MB);
    await expectCode(client().uploadFile(any), 'too_large');
    await Promise.all([rm(image), rm(video), rm(any)]);
  });
  it('upload limits reached', async () => {
    Object.assign(state, { reserveStatus: 429, reserveBody: 'Upload limit reached for this account.' });
    const error = await expectCode(client().uploadFile('~/Pictures/product.png'), 'upload_limit', true);
    expect(error.message).toMatch(/3 unfinished uploads.*250 MB/);
  });
  it('a plain rate limit is not reported as the upload limit', async () => {
    Object.assign(state, { reserveStatus: 429, reserveBody: 'Too many requests' });
    expect((await failure(client().uploadFile('~/Pictures/product.png'))).message).toContain('rate limit');
  });
  it('missing generate scope', async () => {
    Object.assign(state, { reserveStatus: 403, reserveBody: 'browser account or an API key that can generate required' });
    const error = await expectCode(client().uploadFile('~/Pictures/product.png'), 'scope_missing', true);
    expect(error.message).toContain('generate permission');
  });
  it('upload failed, with a retry hint', async () => {
    state.putFailures = 2;
    const error = await expectCode(client().uploadFile('~/Pictures/product.png'), 'upload_failed', true);
    expect(error.message).toMatch(/Retry upload_file/);
    expect(error.details.http_status).toBe(500);
  });
  it('storage unavailable', async () => {
    Object.assign(state, { reserveStatus: 503, reserveBody: 'Media storage is unavailable.' });
    expect((await expectCode(client().uploadFile('~/Pictures/product.png'), 'upload_failed', true)).message).toMatch(/Retry upload_file later/);
  });
  it.each([[410, 'reservation_expired'], [422, 'not_readable'], [409, 'upload_failed']])('complete HTTP %i', async (status, code) => {
    state.completeStatus = status as number;
    await expectCode(client().uploadFile('~/Pictures/product.png'), code as string, true);
  });
  it('refuses a returned link that is not a Raywake file link', async () => {
    state.fileUrl = 'https://elsewhere.example/a.png';
    await expectCode(client().uploadFile('~/Pictures/product.png'), 'upload_failed', true);
  });
});

describe('path safety', () => {
  it.each([
    ['outside the roots', () => path.join(outside, 'elsewhere.png')],
    ['.. escape', () => path.join(cwd, '..', '..', 'outside', 'elsewhere.png')],
    ['relative .. escape', () => '../../outside/elsewhere.png'],
    ['symlink out of the root', () => path.join(home, 'Pictures', 'link-out.png')],
    ['symlink into .ssh', () => path.join(home, 'Pictures', 'link-ssh.png')],
    ['~/.ssh', () => '~/.ssh/id.png'], ['~/.aws', () => '~/.aws/x.jpg'], ['~/.config', () => '~/.config/x.png'],
  ])('refuses %s without network', async (_name, target) => {
    const error = await expectCode(client().uploadFile(target()), 'path_not_allowed');
    expect(error.message).toContain('RAYWAKE_UPLOAD_ROOTS');
  });
  it('a working folder inside a hidden folder does not open it', async () => {
    await expectCode(client({ cwd: path.join(home, '.ssh') }).uploadFile('id.png'), 'path_not_allowed');
  });
  it('does not treat a filesystem-root working folder as an allowed root', async () => {
    await expectCode(client({ cwd: path.parse(root).root }).uploadFile(path.join(outside, 'elsewhere.png')), 'path_not_allowed');
  });
  it('RAYWAKE_UPLOAD_ROOTS replaces the default roots, and hidden folders stay refused', async () => {
    const custom = client({ uploadRoots: [outside, home] });
    expect(await custom.uploadFile(path.join(outside, 'elsewhere.png'))).toMatchObject({ content_type: 'image/png' });
    state.requests.length = 0;
    await expectCode(custom.uploadFile('~/.ssh/id.png'), 'path_not_allowed');
    await expectCode(client({ uploadRoots: [outside] }).uploadFile('~/Pictures/product.png'), 'path_not_allowed');
    await expectCode(client({ uploadRoots: [] }).uploadFile('~/Pictures/product.png'), 'path_not_allowed');
  });
  it('parses the roots variable', () => {
    expect(parseRoots(undefined)).toBeUndefined();
    expect(parseRoots('  ')).toBeUndefined();
    expect(parseRoots(['/a', 'relative', '~/b', ''].join(path.delimiter), '/home/u')).toEqual(['/a', path.join('/home/u', 'b')]);
  });
  it('opens nothing for a refused path: an unreadable file outside the roots is reported as not allowed', async () => {
    const locked = path.join(outside, 'locked.png');
    await writeFile(locked, PNG);
    const handle = await open(locked, 'r');
    await handle.chmod(0o000);
    await handle.close();
    await expectCode(client().uploadFile(locked), 'path_not_allowed');
  });
});

describe('list_media', () => {
  it('lists owned uploads with fresh links and skips anything else', async () => {
    state.storage = [
      { id: 'a1', kind: 'upload', content_type: 'image/png', size_bytes: 10, created_at: '2026-11-11T00:00:00Z', expires_at: '2026-12-11T00:00:00Z', url: `${base}/files/a1?e=1&s=x` },
      { id: 'a2', kind: 'upload', content_type: 'image/png', size_bytes: 10, url: 'https://bucket.example/private/a2' },
      { id: 'o1', kind: 'output', content_type: 'image/png', size_bytes: 10, url: `${base}/files/o1` },
    ];
    const result = await client().listMedia(2);
    expect(result).toEqual({ page: 2, next_page: null, files: [{ asset_id: 'a1', url: `${base}/files/a1?e=1&s=x`, kind: 'image',
      content_type: 'image/png', size_bytes: 10, added_at: '2026-11-11T00:00:00Z', kept_until: '2026-12-11T00:00:00Z' }] });
    expect(state.requests).toEqual(['GET /v1/storage']);
  });
});

describe('MCP surface', () => {
  async function tools() {
    const server = createMcpServer(client());
    const mcp = new Client({ name: 'upload-test', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await mcp.connect(a);
    return { mcp, close: async () => { await mcp.close(); await server.close(); } };
  }
  it('upload_file returns the url and a structured error the assistant can act on', async () => {
    const { mcp, close } = await tools();
    try {
      const ok = await mcp.callTool({ name: 'upload_file', arguments: { path: '~/Pictures/product.png' } });
      expect(ok.isError).not.toBe(true);
      expect(ok.structuredContent).toMatchObject({ url: expect.stringContaining('/files/'), content_type: 'image/png' });
      const bad = await mcp.callTool({ name: 'upload_file', arguments: { path: '~/.ssh/id.png' } });
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent).toMatchObject({ error_code: 'path_not_allowed' });
      expect((await mcp.callTool({ name: 'upload_file', arguments: { path: '' } })).isError).toBe(true);
    } finally { await close(); }
  });
  it('descriptions, instructions and error messages name no provider or storage vendor and keep the upload rules', async () => {
    const { mcp, close } = await tools();
    try {
      const listed = await mcp.listTools();
      const text = JSON.stringify(listed.tools) + PLAYBOOK + messages.join('\n') + (mcp.getInstructions() ?? '');
      expect(messages.length).toBeGreaterThan(10);
      expect(text).not.toMatch(PROVIDERS);
      expect(text).not.toMatch(/credits?\b/i);
      const upload = listed.tools.find(t => t.name === 'upload_file')!;
      expect(upload.description).toMatch(/third-party/);
      expect(upload.description).toMatch(/base64/);
      expect(mcp.getInstructions()).toMatch(/upload_file/);
      expect(mcp.getInstructions()).toMatch(/quote the same model and input again, show the new price_usd/);
    } finally { await close(); }
  });
});
