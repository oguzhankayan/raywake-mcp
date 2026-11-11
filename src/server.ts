import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RaywakeClient, RaywakeError, type JsonObject } from './client.js';
import { PLAYBOOK } from './playbook.js';
import { LIMITS_TEXT, ROOTS_ENV } from './upload.js';

export { RaywakeClient } from './client.js';
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const id = z.string().trim().min(1).max(512);
const model = id.describe('Exact endpoint_id returned by search_models/get_model.');
const input = z.record(z.string(), z.unknown()).describe('Exact input matching the get_model schema. For image/video/audio fields use the url from upload_file or list_media, or a public HTTPS link the user gave; never a local path, data URI or base64.');

async function result(action: () => Promise<JsonObject>): Promise<{
  content: { type: 'text'; text: string }[]; structuredContent: JsonObject; isError?: boolean;
}> {
  try {
    const data = await action();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (error) {
    const data = error instanceof RaywakeError ? { error: error.message, ...error.details } : { error: 'Raywake tool failed. Check the inputs and try again.' };
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: true };
  }
}

export function createMcpServer(client: RaywakeClient): McpServer {
  const server = new McpServer({ name: 'raywake-mcp', version }, { instructions: PLAYBOOK });
  server.registerTool('search_models', {
    description: 'Free. Search Raywake AI models; returns indicative starting prices in USD. Use get_model before quote. Modality filters category/tags locally before pagination.',
    inputSchema: { query: z.string().max(100).optional(), category: z.string().max(100).optional(),
      modality: z.enum(['image', 'video', 'audio']).optional(), page: z.number().int().min(1).max(10000).default(1) },
    annotations: read,
  }, args => result(() => client.searchModels(args)));
  server.registerTool('list_categories', {
    description: 'Free. List the available model categories for search_models.', inputSchema: {}, annotations: read,
  }, () => result(() => client.listCategories()));
  server.registerTool('get_model', {
    description: 'Free. Read a model input schema and indicative starting price in USD. Never invent inputs. For a local file the model should use, call upload_file and put the returned url into the matching media field.',
    inputSchema: { model }, annotations: read,
  }, args => result(() => client.getModel(args.model)));
  server.registerTool('quote', {
    description: 'Free. Get a time-limited USD price for exact model+input without spending balance. Show the price, expiry and any usage-based maximum reservation to the user and obtain approval before generate. If it expires first, quote the same model and input again and show the new USD price before generating.',
    inputSchema: { model, input }, annotations: { ...read, readOnlyHint: false, idempotentHint: false },
  }, args => result(() => client.quote(args.model, args.input)));
  server.registerTool('generate', {
    description: 'PAID: the only tool that spends the user\'s Raywake balance. Call ONLY after the user approves the quoted USD price, with quote_id from quote for exactly the same model+input. Waits up to 45 seconds. Save the returned idempotency_key even on errors; reuse it with the exact request to recover a lost response. Continue existing jobs with free get_job, never a new generation.',
    inputSchema: { model, input, quote_id: id,
      idempotency_key: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/).optional().describe('Saved key for an exact retry. Omit for a new approved generation; the server creates and returns one.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args, extra) => result(() => client.generate(args.model, args.input, args.quote_id, args.idempotency_key, extra.signal)));
  server.registerTool('get_job', {
    description: 'Free. Read an existing job and its outputs, optionally waiting up to 45 seconds. Does not start or bill a new generation. Review states are terminal; do not resubmit.',
    inputSchema: { job_id: id, wait_seconds: z.number().int().min(0).max(45).default(0) }, annotations: read,
  }, (args, extra) => result(() => client.getJob(args.job_id, args.wait_seconds, extra.signal)));
  server.registerTool('list_jobs', {
    description: 'Free. List recent jobs for this account, newest first. Recover an existing job_id and continue with get_job.',
    inputSchema: { limit: z.number().int().min(1).max(500).default(20), offset: z.number().int().min(0).default(0), status: z.string().max(20).optional() }, annotations: read,
  }, args => result(() => client.listJobs(args)));
  server.registerTool('get_account', {
    description: 'Free. Read available, reserved and debt wallet balances in USD. To add balance, top up at https://raywake.si/billing.', inputSchema: {}, annotations: read,
  }, () => result(() => client.getAccount()));
  server.registerTool('upload_file', {
    title: 'Upload a local file',
    description: `Free; spends nothing. Use the user's own image, video or audio file on this computer as a model input: pass its path, and this uploads the unchanged file to the user's private Raywake files in one call and returns url, kind, content_type and size_bytes. Put url unchanged into the model's matching image/video/audio URL input, then quote. Accepted: ${LIMITS_TEXT}. Reads only files in the home folder or working folder (or ${ROOTS_ENV}), never hidden folders such as .ssh or .config. Never upload customer files to third-party hosts, and never shrink, re-encode or embed a file as base64/data URI to avoid uploading.`,
    inputSchema: { path: z.string().trim().min(1).max(4096).describe('Path of one local file, absolute or relative to the working folder; ~ means the home folder.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => result(() => client.uploadFile(args.path, extra.signal)));
  server.registerTool('list_media', {
    title: 'List uploaded files',
    description: 'Free. List the user\'s uploaded input files, newest first, 20 per page, with url, type, size and how long each is kept. Use it to reuse an earlier upload or a file the user added on the Raywake website, and to get a fresh link for a file uploaded more than 7 days ago. Needs the jobs:read permission.',
    inputSchema: { page: z.number().int().min(1).max(500).default(1) }, annotations: read,
  }, args => result(() => client.listMedia(args.page)));
  server.registerTool('get_playbook', {
    description: 'Free. Read the short Raywake workflow: search, schema, free quote, user price approval, paid generate, free job polling. Explains USD prices and how to use local files as inputs.',
    inputSchema: {}, annotations: { ...read, openWorldHint: false },
  }, () => result(async () => ({ guide: PLAYBOOK })));
  return server;
}
