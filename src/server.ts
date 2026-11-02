import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RaywakeClient, RaywakeError, type JsonObject } from './client.js';
import { PLAYBOOK } from './playbook.js';

export { RaywakeClient } from './client.js';
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const id = z.string().trim().min(1).max(512);
const model = id.describe('Exact endpoint_id returned by search_models/get_model.');
const input = z.record(z.string(), z.unknown()).describe('Exact provider-native input matching get_model schema. Media references must be public HTTPS URLs.');

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
    description: 'Free. Read a model input schema and indicative starting price in USD. Never invent inputs. Use public HTTPS URLs for media; local file upload is unavailable.',
    inputSchema: { model }, annotations: read,
  }, args => result(() => client.getModel(args.model)));
  server.registerTool('quote', {
    description: 'Free. Get a time-limited USD price for exact model+input without spending balance. Show the price, expiry and any usage-based maximum reservation to the user and obtain approval before generate.',
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
  server.registerTool('get_playbook', {
    description: 'Free. Read the short Raywake workflow: search, schema, free quote, user price approval, paid generate, free job polling. Explains USD prices and public media URLs.',
    inputSchema: {}, annotations: { ...read, openWorldHint: false },
  }, () => result(async () => ({ guide: PLAYBOOK })));
  return server;
}
