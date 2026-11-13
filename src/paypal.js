// Thin, dependency-free client for the PayPal Invoicing API v2 (sandbox by default).
// Responsibilities: OAuth token caching, retries on transient errors, readable error messages.

export class PayPalError extends Error {
  constructor(message, { status = 502, code = 'PAYPAL_ERROR', debugId = '', details = [] } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.code = code;
    this.debugId = debugId;
    this.details = details;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class PayPalClient {
  constructor({
    clientId,
    clientSecret,
    baseUrl = 'https://api-m.sandbox.paypal.com',
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    timeoutMs = 30_000,
  }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.scope = '';
    this.tokenExpiresAt = 0;
  }

  async getToken({ force = false } = {}) {
    if (!force && this.token && this.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.clientId || !this.clientSecret) {
      throw new PayPalError('PayPal credentials are missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.', {
        status: 500,
        code: 'NO_CREDENTIALS',
      });
    }
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new PayPalError('Could not reach PayPal. Check your internet connection.', { status: 503, code: 'NETWORK' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const reason = data?.error_description || data?.error || '';
      if (res.status === 400 || res.status === 401) {
        throw new PayPalError(
          `PayPal rejected the Client ID / Secret${reason ? ` (${reason})` : ''}. Re-copy both from the same sandbox app in the PayPal Developer Dashboard.`,
          { status: 401, code: 'BAD_CREDENTIALS', debugId: data?.debug_id || '' }
        );
      }
      throw new PayPalError(
        `PayPal did not log us in (HTTP ${res.status}${reason ? `, ${reason}` : ''}). This is usually a temporary PayPal or network problem, not your credentials. Try again in a minute.`,
        { status: 503, code: 'LOGIN_UNAVAILABLE', debugId: data?.debug_id || '' }
      );
    }
    this.token = data.access_token;
    this.scope = String(data.scope || '');
    this.tokenExpiresAt = this.now() + (Number(data.expires_in) || 300) * 1000;
    return this.token;
  }

  /**
   * @param {string} method
   * @param {string} path  e.g. /v2/invoicing/invoices
   * @param {{query?:object, body?:object, headers?:object, retryable?:boolean}} opts
   */
  async request(method, path, { query, body, headers = {}, retryable = method === 'GET' } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));

    let refreshed = false;
    const maxAttempts = retryable ? 3 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const token = await this.getToken();
      let res;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < maxAttempts - 1) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new PayPalError('Could not reach PayPal. Check your internet connection.', { status: 503, code: 'NETWORK' });
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken({ force: true });
        attempt -= 1; // free retry with a fresh token
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < maxAttempts - 1) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (!res.ok) throw toPayPalError(res.status, data);
      return data;
    }
    throw new PayPalError('PayPal request failed.', { status: 502 });
  }

  /** Creates a DRAFT invoice (not visible to the customer until sent). */
  async createDraftInvoice(body, requestId) {
    const data = await this.request('POST', '/v2/invoicing/invoices', {
      body,
      headers: { 'PayPal-Request-Id': requestId, Prefer: 'return=minimal' },
      retryable: true, // safe: PayPal-Request-Id makes the call idempotent
    });
    const href = data?.href || '';
    const id = data?.id || href.split('/').filter(Boolean).pop() || '';
    if (!id) throw new PayPalError('PayPal created the invoice but did not return its ID.', { status: 502 });
    return { id, href };
  }

  /** Moves a draft to SENT (the customer gets the invoice). */
  async sendInvoice(id) {
    const data = await this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
      body: { send_to_recipient: true, send_to_invoicer: true },
    });
    return { href: data?.href || '' };
  }

  async remindInvoice(id, { subject, note }) {
    await this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      body: { subject, note, send_to_invoicer: true },
    });
    return { ok: true };
  }

  /** Cancels a SENT invoice and (optionally) tells the client. */
  async cancelInvoice(id, { subject, note }) {
    await this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
      body: { subject, note, send_to_invoicer: true, send_to_recipient: true },
    });
    return { ok: true };
  }

  /** Records a payment made outside PayPal (bank transfer, cash...) against a sent invoice. */
  async recordPayment(id, { method, date, amount, currency, note }) {
    const body = { method, payment_date: date, amount: { currency_code: currency, value: amount } };
    if (note) body.note = note;
    const data = await this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, { body });
    return { paymentId: data?.payment_id || '' };
  }

  async getInvoice(id) {
    return this.request('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  }

  /** Lists invoices (up to maxPages * pageSize). */
  async listInvoices({ pageSize = 100, maxPages = 5 } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request('GET', '/v2/invoicing/invoices', {
        query: { page, page_size: pageSize, total_required: true },
      });
      const items = data?.items || data?.invoices || [];
      all.push(...items);
      const totalPages = Number(data?.total_pages) || 1;
      if (!items.length || page >= totalPages) break;
    }
    return all;
  }
}

function toPayPalError(status, data) {
  const detail = data?.details?.[0];
  const reason = detail?.description || detail?.issue || data?.message || `HTTP ${status}`;
  const field = detail?.field ? ` (${detail.field})` : '';
  let message = `PayPal said: ${reason}${field}`;
  let code = data?.name || 'PAYPAL_ERROR';

  if (status === 401 || status === 403) {
    // Include PayPal's own explanation (when it gives one) so setup problems can be diagnosed.
    const why = detail?.description || detail?.issue || data?.message;
    message =
      'PayPal refused this request' +
      (why ? ` (${why}${detail?.issue && detail?.description ? `, issue: ${detail.issue}` : ''})` : '') +
      '. Check that the sandbox app has Invoicing enabled, the credentials belong to that app, and the sandbox business account supports invoicing.';
    code = data?.name || 'NOT_AUTHORIZED';
  } else if (status === 429) {
    message = 'PayPal is rate limiting requests (for reminders: only 2 per day are allowed). Try again later.';
    code = 'RATE_LIMITED';
  } else if (status >= 500) {
    message = 'PayPal is having trouble right now. Please try again in a moment.';
  }
  return new PayPalError(message, {
    status,
    code,
    debugId: data?.debug_id || '',
    details: data?.details || [],
  });
}