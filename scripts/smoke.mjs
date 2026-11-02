import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requests = [];
const model = 'example/image/model';
const input = { prompt: 'A lake at sunset' };
let idempotencyKey;
let quoteCreated = false;
const http = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer dummy-smoke-key');
    const url = new URL(req.url, 'http://localhost');
    requests.push(`${req.method} ${url.pathname}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    const send = data => res.end(JSON.stringify(data));
    if (req.method === 'GET' && url.pathname === '/v1/models') return send([{ endpoint_id: model, category: 'text-to-image' }]);
    if (req.method === 'GET' && url.pathname === '/v1/models/categories') return send(['text-to-image']);
    if (req.method === 'GET' && url.pathname === `/v1/models/${model}`) return send({ endpoint_id: model,
      openapi: { components: { schemas: { Input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } } },
      retail_price_guide: { tiers: [{ credits: 25, unit: 'image' }] } });
    if (req.method === 'POST' && url.pathname === '/v1/quotes') {
      assert.deepEqual(JSON.parse(body), { model, input });
      quoteCreated = true;
      return send({ quote_id: 'mock-quote', model, price_usd: '0.25', expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    const job = { job_id: 'mock-job', status: 'succeeded', outputs: [{ type: 'image', url: 'https://media.invalid/result.png' }] };
    if (req.method === 'POST' && url.pathname === '/v1/generate') {
      assert.ok(quoteCreated);
      assert.deepEqual(JSON.parse(body), { model, input, quote_id: 'mock-quote' });
      assert.match(req.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
      if (idempotencyKey) assert.equal(req.headers['idempotency-key'], idempotencyKey);
      idempotencyKey = req.headers['idempotency-key'];
      return send({ job_id: 'mock-job', status: 'running' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/jobs/mock-job') return send(job);
    if (req.method === 'GET' && url.pathname === '/v1/jobs') return send([job]);
    if (req.method === 'GET' && url.pathname === '/v1/wallet') return send({ account_id: 'mock-account', available_usd: '10.00', reserved_usd: '0.00', debt_usd: '0.00' });
    res.writeHead(404);
    send({ detail: 'Unexpected mock route' });
  } catch {
    res.writeHead(500);
    res.end(JSON.stringify({ detail: 'Mock request assertion failed' }));
  }
});
let client;
let transport;
try {
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    // Do not inherit any real Raywake key/base from the invoking shell.
    env: { RAYWAKE_API_KEY: 'dummy-smoke-key', RAYWAKE_API_BASE: baseUrl },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  client = new Client({ name: 'raywake-local-smoke', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['search_models', 'list_categories', 'get_model', 'quote', 'generate', 'get_job', 'list_jobs', 'get_account', 'get_playbook'].sort());
  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent;
  }
  assert.ok((await call('get_playbook')).guide.includes('explicit approval'));
  assert.equal((await call('search_models', { query: 'image' })).models[0].endpoint_id, model);
  assert.deepEqual((await call('list_categories')).categories, ['text-to-image']);
  assert.equal((await call('get_model', { model })).starting_price.price_usd, '0.25');
  assert.equal((await call('get_account')).available_usd, '10.00');
  const quote = await call('quote', { model, input });
  assert.equal(quote.price_usd, '0.25');
  // Approval in this smoke fixture is only for a local fake transaction.
  const generated = await call('generate', { model, input, quote_id: quote.quote_id });
  assert.equal(generated.job_id, 'mock-job');
  assert.equal(generated.status, 'succeeded');
  assert.equal(generated.idempotency_key, idempotencyKey);
  const retried = await call('generate', { model, input, quote_id: quote.quote_id, idempotency_key: generated.idempotency_key });
  assert.equal(retried.idempotency_key, idempotencyKey);
  const job = await call('get_job', { job_id: generated.job_id, wait_seconds: 0 });
  assert.equal(job.status, 'succeeded');
  assert.equal((await call('list_jobs')).jobs[0].job_id, 'mock-job');
  assert.ok(!stderr.includes('dummy-smoke-key'));
  assert.equal(requests.filter(r => r === 'POST /v1/quotes').length, 1);
  assert.equal(requests.filter(r => r === 'POST /v1/generate').length, 2);
  console.log(`Stdio smoke passed: ${tools.length} tools; all tools exercised; quote, polling and idempotent retry used ${baseUrl} only.`);
} finally {
  if (client) await client.close();
  if (transport) await transport.close();
  http.closeAllConnections();
  await new Promise(resolve => http.close(resolve));
}
