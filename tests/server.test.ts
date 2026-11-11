import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, RaywakeClient } from '../src/server.js';

const sessions: { client: Client; server: ReturnType<typeof createMcpServer> }[] = [];
async function connect() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const server = createMcpServer(new RaywakeClient({ apiKey: 'dummy', baseUrl: 'https://mock.invalid', fetch }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  sessions.push({ client, server });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, fetch };
}
afterEach(async () => { for (const { client, server } of sessions.splice(0)) { await client.close(); await server.close(); } });

describe('MCP protocol', () => {
  it('lists all eleven tools with cost descriptions, schemas and annotations', async () => {
    const { client, fetch } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['search_models', 'list_categories', 'get_model', 'quote', 'generate', 'get_job', 'list_jobs', 'get_account', 'get_playbook', 'upload_file', 'list_media'].sort());
    for (const tool of tools) {
      expect(tool.description).toMatch(tool.name === 'generate' ? /PAID.*approves/s : /Free/);
      expect(tool.inputSchema.type).toBe('object');
      if (!['quote', 'generate', 'upload_file'].includes(tool.name)) expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.find(t => t.name === 'generate')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns the playbook without API access', async () => {
    const { client, fetch } = await connect();
    const result = await client.callTool({ name: 'get_playbook', arguments: {} });
    expect(result.structuredContent).toMatchObject({ guide: expect.stringContaining('explicit approval') });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['get_job', { job_id: 'j1', wait_seconds: 46 }], ['get_job', { job_id: 'j1', wait_seconds: -1 }],
    ['generate', { model: 'm', input: {} }], ['generate', { model: 'm', input: {}, quote_id: 'q', idempotency_key: 'bad\nkey' }],
    ['quote', { model: 'm', input: 'not-an-object' }], ['search_models', { page: 0 }],
    ['search_models', { query: 'a'.repeat(101) }], ['list_jobs', { limit: 501 }],
  ])('rejects invalid %s arguments before fetch', async (name, args) => {
    const { client, fetch } = await connect();
    const result = await client.callTool({ name: name as string, arguments: args });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns structured API errors with isError for clients', async () => {
    const { client, fetch } = await connect();
    fetch.mockResolvedValue(new Response('{}', { status: 402 }));
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: expect.stringContaining('https://raywake.si/billing'), http_status: 402 });
  });
});
