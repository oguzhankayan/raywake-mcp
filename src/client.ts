import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type JsonObject = Record<string, unknown>;
export const TERMINAL_STATUSES = new Set([
  'succeeded', 'failed', 'needs_review', 'submission_unknown', 'needs_reconciliation',
]);

export class RaywakeError extends Error {
  constructor(message: string, public readonly details: JsonObject = {}) {
    super(message);
    this.name = 'RaywakeError';
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RaywakeError('Raywake returned an invalid response.');
  }
  return value as JsonObject;
}

// Object key order has no meaning in JSON; array order does.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function usd(value: unknown): string | undefined {
  const amount = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(amount) ? String(amount / 100) : undefined;
}

// These legacy wire amounts are cents (media_platform/money.py), not provider costs.
function priceView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(priceView);
  if (!value || typeof value !== 'object') return value;
  const raw = value as JsonObject;
  const names: Record<string, string> = {
    credits: 'price_usd', exact_credits: 'exact_price_usd',
    credits_per_billing_unit: 'usd_per_billing_unit',
  };
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'provider').map(([key, val]) =>
    names[key] ? [names[key], raw[names[key]] ?? usd(val)] : [key, priceView(val)]));
}

function modelView(raw: JsonObject): JsonObject {
  const { price: _providerPrice, starting_price, retail_pricing, retail_price_guide, ...rest } = raw;
  const guide = priceView(retail_price_guide) as JsonObject | null | undefined;
  let starting = priceView(starting_price);
  // The detail route omits starting_price; derive it from its retail guide.
  if (!starting && Array.isArray(guide?.tiers)) {
    const tiers = (guide.tiers as JsonObject[]).filter(t =>
      Number.isFinite(Number(t.exact_price_usd ?? t.price_usd)));
    if (tiers.length) {
      const tier = tiers.reduce((a, b) => Number(a.exact_price_usd ?? a.price_usd) <=
        Number(b.exact_price_usd ?? b.price_usd) ? a : b);
      starting = { price_usd: tier.exact_price_usd ?? tier.price_usd, unit: tier.unit };
    }
  }
  return { ...rest, starting_price: starting ?? null,
    retail_pricing: priceView(retail_pricing) ?? null, retail_price_guide: guide ?? null };
}

function jobView(raw: JsonObject): JsonObject {
  if (typeof raw.job_id !== 'string' || !raw.job_id || typeof raw.status !== 'string' || !raw.status) {
    throw new RaywakeError('Raywake returned an incomplete job response. Recover using the known job_id or the same generation idempotency_key.');
  }
  const { credits, charged_credits, ...rest } = raw;
  return { ...rest, reserved_usd: raw.reserved_usd ?? usd(credits) ?? null,
    charged_usd: raw.charged_usd ?? usd(charged_credits) ?? null };
}

function apiMessage(status: number, body: string): string {
  if (/quote.*expir|expir.*quote/i.test(body)) return 'Quote expired. Call quote again and get approval for the new USD price.';
  switch (status) {
    case 401: return 'Invalid or revoked API key. Set RAYWAKE_API_KEY using https://raywake.si/api-keys.';
    case 402: return 'Insufficient balance. Please top up at https://raywake.si/billing.';
    case 403: return 'This API key does not have permission for this operation. Check its scopes at https://raywake.si/api-keys.';
    case 404: return 'Model or job not found, or it is not accessible to this account.';
    case 409: return 'Request conflict. Reuse the original idempotency_key with the exact same model, input and quote_id. If the quote is invalid, re-quote and get approval again.';
    case 400:
    case 422: return 'Invalid model input or quote. Read get_model, use its exact input schema, then re-quote if the input changes.';
    case 429: return 'Raywake rate limit reached. Wait before retrying; keep the same idempotency_key for generation retries.';
    default: return `Raywake API request failed (HTTP ${status}). Retry later; keep the same idempotency_key for generation retries.`;
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class RaywakeClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly quotes = new Map<string, { fingerprint: string; expires: number }>();
  private readonly attempts = new Map<string, string>();
  private readonly keys = new Map<string, string>();

  constructor(private readonly options: ClientOptions) {
    if (!options.apiKey.trim()) throw new RaywakeError('RAYWAKE_API_KEY is required. Create a key at https://raywake.si/api-keys.');
    let base: URL;
    try { base = new URL(options.baseUrl ?? 'https://api.raywake.com'); }
    catch { throw new RaywakeError('RAYWAKE_API_BASE must be an HTTPS URL (HTTP is allowed for localhost mocks).'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) ||
      base.username || base.password || base.search || base.hash) {
      throw new RaywakeError('RAYWAKE_API_BASE must be an HTTPS URL without credentials, query or fragment (HTTP is allowed for localhost mocks).');
    }
    this.baseUrl = base.href.replace(/\/$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async request(path: string, options: {
    body?: JsonObject; key?: string; timeoutMs?: number; signal?: AbortSignal;
  } = {}): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const timer = setTimeout(onAbort, Math.max(1, options.timeoutMs ?? 15_000));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: options.body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new RaywakeError(apiMessage(response.status, body), {
          http_status: response.status,
          ...(response.headers.get('retry-after') ? { retry_after: response.headers.get('retry-after') } : {}),
        });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof RaywakeError) throw error;
      // Never expose raw fetch errors or API response bodies, which may echo credentials.
      throw new RaywakeError('Raywake request interrupted or unavailable. For generation, the outcome may be unknown; retry only with the same idempotency_key.');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async searchModels(params: { query?: string; category?: string; modality?: 'image' | 'video' | 'audio'; page?: number }) {
    const page = params.page ?? 1;
    const pageSize = 20;
    const query = new URLSearchParams();
    if (params.query) query.set('search', params.query);
    if (params.category) query.set('category', params.category);
    if (!params.modality) {
      query.set('limit', String(pageSize));
      query.set('offset', String((page - 1) * pageSize));
      const rows = await this.request(`/v1/models?${query}`);
      if (!Array.isArray(rows)) throw new RaywakeError('Raywake returned an invalid model list.');
      return { models: rows.map(row => modelView(object(row))), page, page_size: pageSize,
        next_page: rows.length === pageSize ? page + 1 : null };
    }
    // The gateway has no modality parameter. Filter category/tags before pagination.
    const matches: JsonObject[] = [];
    const pattern = { image: /image/, video: /video/, audio: /audio|speech|music|sound/ }[params.modality];
    let more = true;
    for (let offset = 0; matches.length <= page * pageSize && more; offset += 500) {
      query.set('limit', '500');
      query.set('offset', String(offset));
      const rows = await this.request(`/v1/models?${query}`);
      if (!Array.isArray(rows)) throw new RaywakeError('Raywake returned an invalid model list.');
      more = rows.length === 500;
      matches.push(...rows.map(object).filter(row => pattern.test(
        [row.category, ...(Array.isArray(row.tags) ? row.tags : [])].join(' ').toLowerCase())));
    }
    return { models: matches.slice((page - 1) * pageSize, page * pageSize).map(modelView),
      page, page_size: pageSize, next_page: matches.length > page * pageSize ? page + 1 : null };
  }

  async listCategories() { return { categories: await this.request('/v1/models/categories') }; }

  async getModel(model: string) {
    return modelView(object(await this.request(`/v1/models/${model.split('/').map(encodeURIComponent).join('/')}`)));
  }

  async quote(model: string, input: JsonObject) {
    const raw = object(await this.request('/v1/quotes', { body: { model, input } }));
    if (typeof raw.quote_id !== 'string' || !Number.isFinite(Date.parse(String(raw.expires_at))) ||
      !Number.isFinite(Number(raw.price_usd ?? usd(raw.credits)))) {
      throw new RaywakeError('Raywake returned an invalid quote. Call quote again before generating.');
    }
    this.quotes.set(raw.quote_id, { fingerprint: fingerprint({ model, input }), expires: Date.parse(String(raw.expires_at)) });
    return { quote_id: raw.quote_id, model, price_usd: raw.price_usd ?? usd(raw.credits),
      expires_at: raw.expires_at, settles_on_usage: raw.settles_on_usage ?? false,
      approval_required: true,
      instruction: 'Show this USD price and expiry to the user and obtain approval before calling generate. For usage-settled jobs this is the maximum reservation; unused balance is returned.' };
  }

  async generate(model: string, input: JsonObject, quoteId: string, suppliedKey?: string, signal?: AbortSignal) {
    const identity = fingerprint({ model, input });
    const attempt = fingerprint({ model, input, quote_id: quoteId });
    const existingKey = this.attempts.get(attempt);
    const key = suppliedKey ?? existingKey ?? randomUUID();
    const quote = this.quotes.get(quoteId);
    if (quote && quote.fingerprint !== identity) throw new RaywakeError('Quote does not match this model and input. Call quote again and get approval for the new USD price.');
    if (!quote && !suppliedKey) throw new RaywakeError('Call quote for this exact model and input first. A saved idempotency_key is required to recover an earlier attempt after restarting.');
    if (quote && quote.expires <= Date.now() && !existingKey && !suppliedKey) throw new RaywakeError('Quote expired. Call quote again and get approval for the new USD price.');
    if ((existingKey && existingKey !== key) || (this.keys.has(key) && this.keys.get(key) !== attempt)) {
      throw new RaywakeError('Idempotency conflict. Reuse the original key, model, input and quote_id.');
    }
    this.attempts.set(attempt, key);
    this.keys.set(key, attempt);
    const deadline = Date.now() + 45_000;
    try {
      const job = jobView(object(await this.request('/v1/generate', {
        body: { model, input, quote_id: quoteId }, key, signal,
        timeoutMs: Math.min(15_000, deadline - Date.now()),
      })));
      return { ...await this.waitForJob(job, deadline, signal), idempotency_key: key };
    } catch (error) {
      const known = error instanceof RaywakeError ? error : new RaywakeError('Generation interrupted.');
      throw new RaywakeError(known.message, { ...known.details, idempotency_key: key,
        instruction: 'If submission may have reached Raywake, retry generate with this same key, model, input and quote_id. Never use a new key to recover a lost response.' });
    }
  }

  private async waitForJob(initial: JsonObject, deadline: number, signal?: AbortSignal): Promise<JsonObject> {
    let job = initial;
    while (!TERMINAL_STATUSES.has(String(job.status)) && Date.now() < deadline && !signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 1000) break;
      try {
        await delay(Math.min(1000, remaining), undefined, { signal });
        if (Date.now() >= deadline) break;
        job = jobView(object(await this.request(`/v1/jobs/${encodeURIComponent(String(job.job_id))}`, {
          timeoutMs: Math.min(15_000, deadline - Date.now()), signal,
        })));
      } catch (error) {
        return { ...job, polling_error: error instanceof RaywakeError ? error.message : 'Waiting interrupted.',
          instruction: 'Continue with get_job using this job_id. Do not submit another generation.' };
      }
    }
    return { ...job, ...(!TERMINAL_STATUSES.has(String(job.status)) ? {
      instruction: 'Continue with get_job using this job_id. Do not submit another generation.',
    } : {}) };
  }

  async getJob(jobId: string, waitSeconds = 0, signal?: AbortSignal) {
    const deadline = Date.now() + Math.min(45, Math.max(0, waitSeconds)) * 1000;
    const job = jobView(object(await this.request(`/v1/jobs/${encodeURIComponent(jobId)}`, {
      signal, timeoutMs: waitSeconds > 0 ? Math.max(1, Math.min(15_000, deadline - Date.now())) : 15_000,
    })));
    return this.waitForJob(job, deadline, signal);
  }

  async listJobs(params: { limit?: number; offset?: number; status?: string }) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const rows = await this.request(`/v1/jobs?${query}`);
    if (!Array.isArray(rows)) throw new RaywakeError('Raywake returned an invalid job list.');
    return { jobs: rows.map(row => jobView(object(row))) };
  }

  async getAccount() {
    const raw = object(await this.request('/v1/wallet'));
    return { account_id: raw.account_id, currency: 'USD',
      available_usd: raw.available_usd ?? usd(raw.available_credits),
      reserved_usd: raw.reserved_usd ?? usd(raw.reserved_credits),
      debt_usd: raw.debt_usd ?? usd(raw.debt_credits) };
  }
}
