import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, validateConfig } from '../src/config.js';
import {
  addDays,
  buildPayPalInvoice,
  computeStats,
  evaluateGuards,
  normalizeInvoiceInput,
  normalizePayPalInvoice,
  reminderTone,
  sortInvoices,
} from '../src/invoices.js';
import { PayPalClient, PayPalError } from '../src/paypal.js';
import { AiError, GeminiClient } from '../src/gemini.js';

const limits = { maxInvoiceAmount: 5000, highValueThreshold: 1000, defaultDueDays: 14 };
const TODAY = '2026-11-11';
const noSleep = async () => {};

const validRaw = () => ({
  clientName: 'Priya Sharma',
  clientEmail: 'Priya@Example.com',
  lineItems: [
    { description: 'Copywriting', quantity: 3, unitPrice: 50 },
    { description: 'Hosting setup', quantity: 1, unitPrice: 100 },
  ],
  dueInDays: 10,
});

/* ------------------------------- invoice logic ------------------------------ */

test('normalizeInvoiceInput: computes totals in cents, lowercases email, derives due date', () => {
  const r = normalizeInvoiceInput(validRaw(), { today: TODAY, limits });
  assert.equal(r.ok, true, r.errors.join(' '));
  assert.equal(r.value.totalCents, 25000);
  assert.equal(r.value.clientEmail, 'priya@example.com');
  assert.equal(r.value.dueDate, '2026-11-21');
  assert.equal(r.value.currency, 'USD');
});

test('normalizeInvoiceInput: avoids floating point drift', () => {
  const r = normalizeInvoiceInput(
    { clientName: 'A B', lineItems: [{ description: 'x', quantity: 3, unitPrice: 0.1 }] },
    { today: TODAY, limits }
  );
  assert.equal(r.value.totalCents, 30);
});

test('normalizeInvoiceInput: uses default due days when none given', () => {
  const raw = validRaw();
  delete raw.dueInDays;
  const r = normalizeInvoiceInput(raw, { today: TODAY, limits });
  assert.equal(r.value.dueDate, addDays(TODAY, 14));
});

test('normalizeInvoiceInput: rejects bad input with clear messages', () => {
  const cases = [
    [{ ...validRaw(), clientName: '' }, /Client name/],
    [{ ...validRaw(), clientEmail: 'not-an-email' }, /email looks invalid/],
    [{ ...validRaw(), currency: 'XYZ' }, /not supported/],
    [{ ...validRaw(), lineItems: [] }, /At least one line item/],
    [{ ...validRaw(), lineItems: [{ description: 'x', quantity: 1, unitPrice: 0 }] }, /price must be greater/],
    [{ ...validRaw(), lineItems: [{ description: '', quantity: 1, unitPrice: 5 }] }, /description is required/],
    [{ ...validRaw(), dueInDays: undefined, dueDate: '2020-01-01' }, /in the past/],
    [{ ...validRaw(), dueInDays: undefined, dueDate: '2026-02-31' }, /valid date/],
  ];
  for (const [raw, re] of cases) {
    const r = normalizeInvoiceInput(raw, { today: TODAY, limits });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), re);
  }
});

test('normalizeInvoiceInput: email is only mandatory when requireEmail is set', () => {
  const raw = { ...validRaw(), clientEmail: '' };
  assert.equal(normalizeInvoiceInput(raw, { today: TODAY, limits }).ok, true);
  const strict = normalizeInvoiceInput(raw, { today: TODAY, limits, requireEmail: true });
  assert.equal(strict.ok, false);
  assert.match(strict.errors[0], /email is required/);
});

test('buildPayPalInvoice: produces the PayPal v2 shape', () => {
  const { value } = normalizeInvoiceInput(validRaw(), { today: TODAY, limits });
  const body = buildPayPalInvoice(value, { invoicerEmail: 'merchant@example.com' });
  assert.equal(body.detail.currency_code, 'USD');
  assert.deepEqual(body.detail.payment_term, { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-11-21' });
  assert.deepEqual(body.primary_recipients[0].billing_info.name, { given_name: 'Priya', surname: 'Sharma' });
  assert.equal(body.primary_recipients[0].billing_info.email_address, 'priya@example.com');
  assert.deepEqual(body.items[0], { name: 'Copywriting', quantity: '3', unit_amount: { currency_code: 'USD', value: '50.00' } });
  assert.equal(body.invoicer.email_address, 'merchant@example.com');
});

test('buildPayPalInvoice: single-word client becomes a business name', () => {
  const { value } = normalizeInvoiceInput({ ...validRaw(), clientName: 'Acme' }, { today: TODAY, limits });
  const body = buildPayPalInvoice(value);
  assert.equal(body.primary_recipients[0].billing_info.business_name, 'Acme');
  assert.equal(body.invoicer, undefined);
});

test('evaluateGuards: hard cap, high value, new client and duplicate', () => {
  const big = normalizeInvoiceInput({ ...validRaw(), lineItems: [{ description: 'x', quantity: 1, unitPrice: 6000 }] }, { today: TODAY, limits }).value;
  assert.equal(evaluateGuards(big, { limits }).blockers.length, 1);

  const high = normalizeInvoiceInput({ ...validRaw(), lineItems: [{ description: 'x', quantity: 1, unitPrice: 1500 }] }, { today: TODAY, limits }).value;
  const g = evaluateGuards(high, { limits, knownEmails: new Set(['someone@else.com']) });
  assert.equal(g.requiresConfirm, true);
  assert.equal(g.flags.newClient, true);
  assert.equal(g.blockers.length, 0);

  const normal = normalizeInvoiceInput(validRaw(), { today: TODAY, limits }).value;
  const now = Date.now();
  const dup = evaluateGuards(normal, { limits, recentSent: [{ email: 'priya@example.com', totalCents: 25000, ts: now - 1000 }], now });
  assert.equal(dup.flags.duplicate, true);
  const old = evaluateGuards(normal, { limits, recentSent: [{ email: 'priya@example.com', totalCents: 25000, ts: now - 3 * 86_400_000 }], now });
  assert.equal(old.flags.duplicate, false);
});

test('normalizePayPalInvoice + stats: overdue detection and totals', () => {
  const mk = (id, status, due, amount, email = 'a@b.com') => ({
    id,
    status,
    detail: { invoice_number: `N-${id}`, currency_code: 'USD', payment_term: { due_date: due } },
    primary_recipients: [{ billing_info: { name: { given_name: 'Ann', surname: 'Lee' }, email_address: email } }],
    amount: { currency_code: 'USD', value: amount },
    due_amount: { currency_code: 'USD', value: status === 'PAID' ? '0.00' : amount },
  });
  const rows = sortInvoices(
    [mk('1', 'SENT', '2026-11-01', '100.00'), mk('2', 'PAID', '2026-10-01', '250.50'), mk('3', 'UNPAID', '2026-12-01', '40.00'), mk('4', 'DRAFT', '2026-12-01', '10.00')].map((i) =>
      normalizePayPalInvoice(i, TODAY)
    )
  );
  assert.equal(rows[0].category, 'overdue');
  assert.equal(rows[0].daysOverdue, 10);
  assert.equal(rows[0].clientName, 'Ann Lee');
  const stats = computeStats(rows);
  assert.equal(stats.outstanding, 140);
  assert.equal(stats.overdueCount, 1);
  assert.equal(stats.paidAmount, 250.5);
  assert.equal(stats.draftCount, 1);
});

test('reminderTone escalates with lateness', () => {
  assert.equal(reminderTone(0), 'friendly');
  assert.equal(reminderTone(7), 'friendly');
  assert.equal(reminderTone(8), 'firm');
  assert.equal(reminderTone(21), 'firm');
  assert.equal(reminderTone(22), 'final');
});

/* ---------------------------------- config ---------------------------------- */

test('validateConfig: refuses non-sandbox PayPal URL unless ALLOW_LIVE=true', () => {
  const base = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', GEMINI_API_KEY: 'k' };
  assert.equal(validateConfig(loadConfig(base)).errors.length, 0);
  const live = validateConfig(loadConfig({ ...base, PAYPAL_BASE_URL: 'https://api-m.paypal.com' }));
  assert.match(live.errors.join(' '), /sandbox/i);
  const allowed = validateConfig(loadConfig({ ...base, PAYPAL_BASE_URL: 'https://api-m.paypal.com', ALLOW_LIVE: 'true' }));
  assert.equal(allowed.errors.length, 0);
  assert.equal(allowed.warnings.length, 1);
  assert.match(validateConfig(loadConfig({})).errors.join(' '), /PAYPAL_CLIENT_ID/);
});

/* -------------------------------- PayPal client ----------------------------- */

const jsonRes = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function parseBody(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // e.g. the form-encoded OAuth token request
  }
}

function makePayPal(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, search: u.search, headers: init.headers, body: parseBody(init.body) });
    return handler(u, init, calls);
  };
  const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', baseUrl: 'https://api-m.sandbox.paypal.com', fetchImpl, sleep: noSleep });
  return { client, calls };
}

const tokenOk = () => jsonRes(200, { access_token: 'tok', expires_in: 3600 });

test('PayPalClient: caches the OAuth token and sends Basic auth', async () => {
  const { client, calls } = makePayPal((u) => (u.pathname === '/v1/oauth2/token' ? tokenOk() : jsonRes(200, { items: [], total_pages: 1 })));
  await client.listInvoices();
  await client.listInvoices();
  assert.equal(calls.filter((c) => c.path === '/v1/oauth2/token').length, 1);
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');
});

test('PayPalClient: createDraftInvoice extracts the id from the returned link and sets PayPal-Request-Id', async () => {
  const { client, calls } = makePayPal((u) =>
    u.pathname === '/v1/oauth2/token' ? tokenOk() : jsonRes(201, { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-ABCD-1234', method: 'GET' })
  );
  const out = await client.createDraftInvoice({ detail: {} }, 'req-1');
  assert.equal(out.id, 'INV2-ABCD-1234');
  const call = calls.find((c) => c.method === 'POST' && c.path === '/v2/invoicing/invoices');
  assert.equal(call.headers['PayPal-Request-Id'], 'req-1');
});

test('PayPalClient: sendInvoice and remindInvoice hit the right endpoints (204 body handled)', async () => {
  const { client, calls } = makePayPal((u) => {
    if (u.pathname === '/v1/oauth2/token') return tokenOk();
    if (u.pathname.endsWith('/send')) return jsonRes(200, { rel: 'invoice', href: 'https://www.sandbox.paypal.com/invoice/p/#X' });
    return new Response(null, { status: 204 });
  });
  const sent = await client.sendInvoice('INV2-1');
  assert.equal(sent.href, 'https://www.sandbox.paypal.com/invoice/p/#X');
  await client.remindInvoice('INV2-1', { subject: 'Hi', note: 'Please pay' });
  const remind = calls.find((c) => c.path.endsWith('/remind'));
  assert.deepEqual(remind.body, { subject: 'Hi', note: 'Please pay', send_to_invoicer: true });
});

test('PayPalClient: paginates the invoice list', async () => {
  const { client, calls } = makePayPal((u) => {
    if (u.pathname === '/v1/oauth2/token') return tokenOk();
    const page = Number(u.searchParams.get('page'));
    return jsonRes(200, { total_pages: 2, items: [{ id: `P${page}` }] });
  });
  const all = await client.listInvoices();
  assert.deepEqual(all.map((i) => i.id), ['P1', 'P2']);
  assert.equal(calls.filter((c) => c.path === '/v2/invoicing/invoices').length, 2);
});

test('PayPalClient: refreshes the token once on 401', async () => {
  let first = true;
  const { client, calls } = makePayPal((u) => {
    if (u.pathname === '/v1/oauth2/token') return tokenOk();
    if (first) {
      first = false;
      return jsonRes(401, { name: 'AUTHENTICATION_FAILURE' });
    }
    return jsonRes(200, { items: [{ id: 'ok' }], total_pages: 1 });
  });
  const items = await client.listInvoices();
  assert.equal(items[0].id, 'ok');
  assert.equal(calls.filter((c) => c.path === '/v1/oauth2/token').length, 2);
});

test('PayPalClient: GET retries on 503 but POST send does not', async () => {
  let gets = 0;
  const a = makePayPal((u) => {
    if (u.pathname === '/v1/oauth2/token') return tokenOk();
    gets += 1;
    return gets < 3 ? jsonRes(503, {}) : jsonRes(200, { items: [], total_pages: 1 });
  });
  await a.client.listInvoices();
  assert.equal(gets, 3);

  let posts = 0;
  const b = makePayPal((u) => {
    if (u.pathname === '/v1/oauth2/token') return tokenOk();
    posts += 1;
    return jsonRes(503, {});
  });
  await assert.rejects(() => b.client.sendInvoice('X'), PayPalError);
  assert.equal(posts, 1);
});

test('PayPalClient: maps errors to readable messages', async () => {
  const { client } = makePayPal((u) =>
    u.pathname === '/v1/oauth2/token'
      ? tokenOk()
      : jsonRes(422, { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg1', details: [{ issue: 'X', description: 'Invoice is already sent.', field: '/status' }] })
  );
  await assert.rejects(
    () => client.sendInvoice('X'),
    (err) => err instanceof PayPalError && /already sent/.test(err.message) && err.debugId === 'dbg1' && err.status === 422
  );

  const bad = makePayPal(() => jsonRes(401, { error: 'invalid_client' }));
  await assert.rejects(() => bad.client.getToken(), /Client ID \/ Secret/);
});


test('PayPalClient: 403 errors surface PayPal\'s own reason', async () => {
  const { client } = makePayPal((u) =>
    u.pathname === '/v1/oauth2/token'
      ? tokenOk()
      : jsonRes(403, { name: 'NOT_AUTHORIZED', message: 'Authorization failed due to insufficient permissions.', debug_id: 'dbg2', details: [{ issue: 'PERMISSION_DENIED', description: 'Merchant cannot use invoicing.' }] })
  );
  await assert.rejects(
    () => client.listInvoices(),
    (err) => err instanceof PayPalError && /Merchant cannot use invoicing/.test(err.message) && /PERMISSION_DENIED/.test(err.message) && err.debugId === 'dbg2' && err.status === 403
  );
});


test('PayPalClient: a PayPal outage during login is not reported as bad credentials', async () => {
  const down = makePayPal(() => new Response('<html>Service Unavailable</html>', { status: 503 }));
  await assert.rejects(
    () => down.client.getToken(),
    (err) => err.code === 'LOGIN_UNAVAILABLE' && /HTTP 503/.test(err.message) && !/Client ID/.test(err.message)
  );
});

/* --------------------------------- Gemini client ---------------------------- */

function makeGemini(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return handler(calls.length, calls);
  };
  return { client: new GeminiClient({ apiKey: 'KEY', model: 'test-model', baseUrl: 'https://example.test/v1beta', fetchImpl, sleep: noSleep }), calls };
}

test('GeminiClient: sends key header, tools and parses function calls with raw parts preserved', async () => {
  const parts = [{ functionCall: { name: 'list_invoices', args: { status: 'unpaid' } }, thoughtSignature: 'SIG' }];
  const { client, calls } = makeGemini(() => jsonRes(200, { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }));
  const res = await client.generate({
    systemInstruction: 'sys',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    functionDeclarations: [{ name: 'list_invoices', description: 'd', parameters: { type: 'object', properties: {} } }],
  });
  assert.equal(calls[0].url, 'https://example.test/v1beta/models/test-model:generateContent');
  assert.equal(calls[0].headers['x-goog-api-key'], 'KEY');
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'sys');
  assert.equal(calls[0].body.tools[0].functionDeclarations[0].name, 'list_invoices');
  assert.deepEqual(res.functionCalls, [{ name: 'list_invoices', args: { status: 'unpaid' } }]);
  assert.equal(res.content.parts[0].thoughtSignature, 'SIG');
});

test('GeminiClient: retries 429 then succeeds; gives a friendly error when it keeps failing', async () => {
  const ok = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };
  const a = makeGemini((n) => (n < 3 ? jsonRes(429, { error: { message: 'quota' } }) : jsonRes(200, ok)));
  assert.equal((await a.client.generate({ contents: [] })).text, 'hello');
  assert.equal(a.calls.length, 3);

  const b = makeGemini(() => jsonRes(429, { error: { message: 'quota' } }));
  await assert.rejects(() => b.client.generate({ contents: [] }), (e) => e instanceof AiError && e.status === 429 && /quota is busy/.test(e.message));
  assert.equal(b.calls.length, 4);
});

test('GeminiClient: maps key, model and blocked-prompt errors', async () => {
  const key = makeGemini(() => jsonRes(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }));
  await assert.rejects(() => key.client.generate({ contents: [] }), /GEMINI_API_KEY/);
  const model = makeGemini(() => jsonRes(404, { error: { message: 'models/test-model is not found' } }));
  await assert.rejects(() => model.client.generate({ contents: [] }), /GEMINI_MODEL/);
  const blocked = makeGemini(() => jsonRes(200, { promptFeedback: { blockReason: 'SAFETY' } }));
  await assert.rejects(() => blocked.client.generate({ contents: [] }), /SAFETY/);
});

test('GeminiClient: falls back to the next model when one times out or is unavailable', async () => {
  const seenModels = [];
  const ok = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };
  const fetchImpl = async (url) => {
    const model = /models\/([^:]+):/.exec(String(url))[1];
    seenModels.push(model);
    if (model === 'slow-model') {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    if (model === 'gone-model') return jsonRes(404, { error: { message: 'not found' } });
    return jsonRes(200, ok);
  };
  const client = new GeminiClient({ apiKey: 'K', model: 'slow-model, gone-model ,good-model', baseUrl: 'https://example.test/v1beta', fetchImpl, sleep: noSleep });
  const res = await client.generate({ contents: [] });
  assert.equal(res.text, 'hello');
  assert.equal(res.model, 'good-model');
  assert.deepEqual(seenModels, ['slow-model', 'gone-model', 'good-model']);
});

test('GeminiClient: a rejected API key stops immediately instead of trying every model', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonRes(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
  };
  const client = new GeminiClient({ apiKey: 'bad', model: 'a,b,c', baseUrl: 'https://example.test/v1beta', fetchImpl, sleep: noSleep });
  await assert.rejects(() => client.generate({ contents: [] }), /GEMINI_API_KEY/);
  assert.equal(calls, 1);
});