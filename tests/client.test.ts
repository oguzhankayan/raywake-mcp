import { describe, expect, it, vi } from 'vitest';
import { RaywakeClient, RaywakeError, TERMINAL_STATUSES } from '../src/client.js';

const input = { prompt: 'A mountain lake', settings: { width: 1024, height: 1024 } };
const model = 'example/image/model';
function response(data: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, client: new RaywakeClient({ apiKey: 'dummy-test-key', baseUrl: 'https://mock.invalid', fetch }) };
}
function quoteResponse(expires = Date.now() + 60_000) {
  return response({ quote_id: 'q1', model, price_usd: '0.32', credits: 32, expires_at: new Date(expires).toISOString() });
}

describe('HTTP and API contract', () => {
  it('requires a key without printing it', () => {
    expect(() => new RaywakeClient({ apiKey: '' })).toThrow('RAYWAKE_API_KEY is required');
  });
  it.each(['http://example.com', 'https://user:secret@example.com', 'https://example.com?token=x', 'not-a-url'])('rejects unsafe base %s', baseUrl => {
    expect(() => new RaywakeClient({ apiKey: 'dummy', baseUrl })).toThrow('RAYWAKE_API_BASE');
  });
  it('maps search pagination to actual gateway params and sends Bearer auth', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(response([]));
    await client.searchModels({ query: 'mountain & lake', category: 'text-to-image', page: 3 });
    const [url, init] = fetch.mock.calls[0];
    const parsed = new URL(String(url));
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ search: 'mountain & lake', category: 'text-to-image', limit: '20', offset: '40' });
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer dummy-test-key' });
    expect(init?.redirect).toBe('error');
  });
  it('filters modality across upstream pages before paginating', async () => {
    const { fetch, client } = setup();
    const images = Array.from({ length: 500 }, (_, n) => ({ endpoint_id: `image/${n}`, category: 'text-to-image' }));
    const videos = Array.from({ length: 25 }, (_, n) => ({ endpoint_id: `video/${n}`, category: 'image-to-video' }));
    fetch.mockResolvedValueOnce(response(images)).mockResolvedValueOnce(response(videos));
    const result = await client.searchModels({ modality: 'video', page: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('offset')).toBe('500');
    expect(result.models.map(m => m.endpoint_id)).toEqual(videos.slice(20).map(m => m.endpoint_id));
    expect(result.next_page).toBeNull();
  });
  it.each(['speech', 'music', 'audio'])('matches audio category %s', async category => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(response([{ endpoint_id: 'audio/model', category }]));
    expect((await client.searchModels({ modality: 'audio' })).models).toHaveLength(1);
  });
  it('preserves schema and derives a retail USD starting price without provider costs', async () => {
    const { fetch, client } = setup();
    const openapi = { components: { schemas: { Input: { properties: { credits: { type: 'string' } } } } } };
    fetch.mockResolvedValue(response({ endpoint_id: model, openapi, price: { unit_price: 'private' }, retail_price_guide: {
      tiers: [{ credits: 25, unit: 'second' }, { credits: 10, exact_credits: '9.9', unit: 'second' }],
    } }));
    const result = await client.getModel(model);
    expect(String(fetch.mock.calls[0][0])).toBe(`https://mock.invalid/v1/models/${model}`);
    expect(result.openapi).toEqual(openapi);
    expect(result.starting_price).toEqual({ price_usd: '0.099', unit: 'second' });
    expect(result).not.toHaveProperty('price');
    expect(result.retail_price_guide).toEqual({ tiers: [
      { price_usd: '0.25', unit: 'second' }, { price_usd: '0.1', exact_price_usd: '0.099', unit: 'second' },
    ] });
  });
  it('reads categories, job history and USD wallet with exact account-safe paths', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(response(['text-to-image']))
      .mockResolvedValueOnce(response([{ job_id: 'j1', status: 'succeeded', credits: 32, charged_credits: 25 }]))
      .mockResolvedValueOnce(response({ account_id: 'a1', available_usd: '12.50', reserved_usd: '0.32', debt_usd: '0.00', available_credits: 1250 }));
    expect(await client.listCategories()).toEqual({ categories: ['text-to-image'] });
    const jobs = await client.listJobs({ limit: 3, offset: 6, status: 'succeeded' });
    expect(String(fetch.mock.calls[1][0])).toBe('https://mock.invalid/v1/jobs?limit=3&offset=6&status=succeeded');
    expect(jobs.jobs[0]).toMatchObject({ reserved_usd: '0.32', charged_usd: '0.25' });
    expect(jobs.jobs[0]).not.toHaveProperty('credits');
    const account = await client.getAccount();
    expect(account).toEqual({ account_id: 'a1', currency: 'USD', available_usd: '12.50', reserved_usd: '0.32', debt_usd: '0.00' });
    expect(JSON.stringify(account)).not.toMatch(/credits/);
    expect(String(fetch.mock.calls[2][0])).toBe('https://mock.invalid/v1/wallet');
  });
  it.each([
    [401, 'Invalid or revoked API key'], [402, 'top up at https://raywake.si/billing'],
    [403, 'permission'], [404, 'not found'], [409, 'conflict'], [422, 'Invalid model input'], [429, 'rate limit'],
  ])('maps HTTP %i and never exposes raw bodies or keys', async (status, message) => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(response({ detail: 'echo dummy-test-key' }, Number(status), { 'Retry-After': '10' }));
    try { await client.getAccount(); expect.fail('must throw'); }
    catch (error) {
      expect(error).toBeInstanceOf(RaywakeError);
      expect((error as Error).message).toContain(String(message));
      expect(String(error)).not.toContain('dummy-test-key');
      expect((error as RaywakeError).details.retry_after).toBe('10');
    }
  });
  it('maps expired-quote errors to a new quote and approval', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(response({ detail: 'quote expired' }, 409));
    await expect(client.getAccount()).rejects.toThrow('Call quote again');
  });
  it('does not expose network exception text', async () => {
    const { fetch, client } = setup();
    fetch.mockRejectedValue(new Error('Bearer dummy-test-key'));
    await expect(client.getAccount()).rejects.toThrow('request interrupted');
    await expect(client.getAccount()).rejects.not.toThrow('dummy-test-key');
  });
});

describe('quote and paid generation safety', () => {
  it('quotes for free and exposes only USD pricing with expiry and approval instructions', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(quoteResponse());
    const quote = await client.quote(model, input);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, input });
    expect(quote).toMatchObject({ price_usd: '0.32', quote_id: 'q1', approval_required: true });
    expect(quote).not.toHaveProperty('credits');
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('Idempotency-Key');
  });
  it('rejects an unknown quote before network submission for a new generation', async () => {
    const { fetch, client } = setup();
    await expect(client.generate(model, input, 'unknown')).rejects.toThrow('Call quote');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ ...input, prompt: 'changed' }, { ...input, settings: { width: 512, height: 1024 } }])('rejects changed inputs', async changed => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(quoteResponse());
    await client.quote(model, input);
    await expect(client.generate(model, changed, 'q1')).rejects.toThrow('does not match');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed model and expired quote without submission', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(quoteResponse(Date.now() - 100));
    await client.quote(model, input);
    await expect(client.generate('other/model', input, 'q1')).rejects.toThrow('does not match');
    await expect(client.generate(model, input, 'q1')).rejects.toThrow('Quote expired');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('canonicalizes nested object keys, sends exact body and reuses a generated key on retries', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(quoteResponse()).mockImplementation(async () => response({ job_id: 'j1', status: 'succeeded' }));
    await client.quote(model, input);
    const reordered = { settings: { height: 1024, width: 1024 }, prompt: input.prompt };
    const first = await client.generate(model, reordered, 'q1');
    const second = await client.generate(model, input, 'q1');
    expect(first.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(fetch.mock.calls[1][1]?.headers).toHaveProperty('Idempotency-Key', first.idempotency_key);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ model, input: reordered, quote_id: 'q1' });
    await expect(client.generate(model, input, 'q1', 'different-key')).rejects.toThrow('Idempotency conflict');
  });
  it('returns the key after a lost submission response and reuses it on recovery', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(quoteResponse()).mockRejectedValueOnce(new Error('socket gone'))
      .mockResolvedValueOnce(response({ job_id: 'recovered', status: 'succeeded' }));
    await client.quote(model, input);
    let key = '';
    try { await client.generate(model, input, 'q1'); expect.fail(); }
    catch (error) { key = String((error as RaywakeError).details.idempotency_key); }
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const result = await client.generate(model, input, 'q1', key);
    expect(result).toMatchObject({ job_id: 'recovered', idempotency_key: key });
    expect(fetch.mock.calls[1][1]?.headers).toHaveProperty('Idempotency-Key', key);
    expect(fetch.mock.calls[2][1]?.headers).toHaveProperty('Idempotency-Key', key);
  });
  it('allows exact saved-key recovery after restart and leaves binding enforcement to the gateway', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(response({ job_id: 'recovered', status: 'succeeded' }));
    expect(await client.generate(model, input, 'saved-quote', 'saved-key')).toMatchObject({ job_id: 'recovered', idempotency_key: 'saved-key' });
  });
  it('rejects key reuse for different requests within this process', async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(response({ job_id: 'j1', status: 'succeeded' }));
    await client.generate(model, input, 'saved-quote', 'saved-key');
    await expect(client.generate(model, input, 'other-quote', 'saved-key')).rejects.toThrow('Idempotency conflict');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('replays an already submitted request after quote expiry with the original key', async () => {
    vi.useFakeTimers();
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(quoteResponse(Date.now() + 1000)).mockImplementation(async () => response({ job_id: 'j1', status: 'succeeded' }));
    await client.quote(model, input);
    const first = await client.generate(model, input, 'q1');
    vi.advanceTimersByTime(2000);
    const retry = await client.generate(model, input, 'q1');
    expect(retry.idempotency_key).toBe(first.idempotency_key);
  });
});

describe('bounded waiting', () => {
  it.each([...TERMINAL_STATUSES])('does not poll terminal %s', async status => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(response({ job_id: 'j1', status }));
    expect(await client.getJob('j1', 45)).toMatchObject({ job_id: 'j1', status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('continues polling and preserves media outputs', async () => {
    vi.useFakeTimers();
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(response({ job_id: 'j1', status: 'running' }))
      .mockResolvedValueOnce(response({ job_id: 'j1', status: 'succeeded', outputs: [{ type: 'image', url: 'https://media.invalid/output.png' }] }));
    const pending = client.getJob('j1', 45);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: 'succeeded', outputs: [{ type: 'image', url: 'https://media.invalid/output.png' }] });
  });
  it('returns a running job and the key within 45 seconds without another POST', async () => {
    vi.useFakeTimers();
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(quoteResponse()).mockImplementation(async () => response({ job_id: 'j1', status: 'running' }));
    await client.quote(model, input);
    const start = Date.now();
    const pending = client.generate(model, input, 'q1');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toMatchObject({ job_id: 'j1', status: 'running', idempotency_key: expect.any(String), instruction: expect.stringContaining('get_job') });
    const postCalls = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(postCalls).toHaveLength(2); // one free quote, one paid submit
    expect(Date.now() - start).toBe(45_000);
  });
  it('retains the job and key when polling fails', async () => {
    vi.useFakeTimers();
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(quoteResponse()).mockResolvedValueOnce(response({ job_id: 'j1', status: 'running' }))
      .mockResolvedValueOnce(response({}, 429));
    await client.quote(model, input);
    const pending = client.generate(model, input, 'q1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ job_id: 'j1', status: 'running', polling_error: expect.stringContaining('rate limit'), idempotency_key: expect.any(String) });
  });
  it('preserves the last valid job when a poll returns malformed data', async () => {
    vi.useFakeTimers();
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(response({ job_id: 'j1', status: 'running' }))
      .mockResolvedValueOnce(response({}));
    const pending = client.getJob('j1', 45);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ job_id: 'j1', status: 'running', polling_error: expect.stringContaining('incomplete job') });
  });
  it('caps a stalled submission and includes its recovery key', async () => {
    vi.useFakeTimers();
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(quoteResponse()).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await client.quote(model, input);
    const pending = client.generate(model, input, 'q1').catch(error => error as RaywakeError);
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await pending;
    expect(error).toBeInstanceOf(RaywakeError);
    expect((error as RaywakeError).details.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });
});
