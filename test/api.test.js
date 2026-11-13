import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { PayPalClient } from '../src/paypal.js';
import { GeminiClient } from '../src/gemini.js';

const TODAY = new Date().toISOString().slice(0, 10);

const config = () =>
  loadConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', GEMINI_API_KEY: 'k', CHAT_RATE_PER_MIN: '1000', ACTION_RATE_PER_MIN: '1000' });

/* ----------------------------- fakes and helpers ---------------------------- */

function fakePayPal(initial = []) {
  const state = { invoices: [...initial], created: [], sent: [], reminded: [], failSendOnce: false };
  return {
    state,
    async listInvoices() {
      return state.invoices;
    },
    async createDraftInvoice(body, requestId) {
      const id = `INV2-${state.created.length + 1}`;
      state.created.push({ id, body, requestId });
      return { id, href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}` };
    },
    async sendInvoice(id) {
      if (state.failSendOnce) {
        state.failSendOnce = false;
        const { PayPalError } = await import('../src/paypal.js');
        throw new PayPalError('PayPal said: temporary problem', { status: 502 });
      }
      state.sent.push(id);
      return { href: `https://www.sandbox.paypal.com/invoice/p/#${id}` };
    },
    async remindInvoice(id, payload) {
      state.reminded.push({ id, ...payload });
      return { ok: true };
    },
  };
}

/** A scripted "model": each entry is either {calls:[{name,args}]} or {text}. Records what it was sent. */
function scriptedAi(script) {
  const seen = [];
  let i = 0;
  return {
    seen,
    async generate(req) {
      seen.push(JSON.parse(JSON.stringify(req.contents)));
      const step = script[Math.min(i++, script.length - 1)];
      const parts = step.calls ? step.calls.map((c) => ({ functionCall: { name: c.name, args: c.args }, thoughtSignature: 'sig' })) : [{ text: step.text }];
      return { content: { role: 'model', parts }, parts, text: step.text || '', functionCalls: step.calls || [], finishReason: 'STOP' };
    },
  };
}

async function start({ paypal = fakePayPal(), ai = scriptedAi([{ text: 'ok' }]), cfg = config() } = {}) {
  const store = new Store({ persist: false });
  const app = createApp({ config: cfg, paypal, ai, store });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  return { call, base, store, paypal, ai, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const invoiceArgs = (over = {}) => ({
  client_name: 'Priya Sharma',
  client_email: 'priya@example.com',
  line_items: [
    { description: 'Copywriting', quantity: 3, unit_price: 50 },
    { description: 'Hosting setup', quantity: 1, unit_price: 100 },
  ],
  due_in_days: 10,
  ...over,
});

const chat = (call, text) => call('POST', '/api/chat', { messages: [{ role: 'user', text }], today: TODAY });

/* ----------------------------------- tests ---------------------------------- */

test('chat: the AI prepares a proposal but NOTHING is created or sent in PayPal', async () => {
  const ai = scriptedAi([{ calls: [{ name: 'prepare_invoice', args: invoiceArgs() }] }, { text: 'Ready for your approval.' }]);
  const t = await start({ ai });
  const res = await chat(t.call, 'Invoice Priya');
  assert.equal(res.status, 200);
  assert.equal(res.json.reply, 'Ready for your approval.');
  assert.equal(res.json.proposals.length, 1);
  const p = res.json.proposals[0];
  assert.equal(p.type, 'invoice');
  assert.equal(p.status, 'pending');
  assert.equal(p.invoice.total, 250);
  assert.equal(t.paypal.state.created.length, 0);
  assert.equal(t.paypal.state.sent.length, 0);
  // the model's raw parts (with thoughtSignature) were echoed back in the follow-up request
  const followUp = t.ai.seen[1];
  assert.equal(followUp[1].parts[0].thoughtSignature, 'sig');
  assert.equal(followUp[2].parts[0].functionResponse.response.status, 'awaiting_user_approval');
  await t.close();
});

test('approve: requires an email, accepts edits, creates the draft then sends, and is idempotent', async () => {
  const ai = scriptedAi([{ calls: [{ name: 'prepare_invoice', args: invoiceArgs({ client_email: undefined }) }] }, { text: 'done' }]);
  const t = await start({ ai });
  const { json } = await chat(t.call, 'Invoice Priya');
  const id = json.proposals[0].id;

  const noEmail = await t.call('POST', `/api/proposals/${id}/approve`, { today: TODAY });
  assert.equal(noEmail.status, 422);
  assert.match(noEmail.json.error, /email is required/);
  assert.equal(t.paypal.state.created.length, 0);

  const ok = await t.call('POST', `/api/proposals/${id}/approve`, { today: TODAY, edits: { clientEmail: 'Priya@Example.com', note: 'Thanks!' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.proposal.status, 'done');
  assert.equal(ok.json.proposal.result.invoiceId, 'INV2-1');
  assert.equal(ok.json.proposal.result.link, 'https://www.sandbox.paypal.com/invoice/p/#INV2-1');
  assert.equal(t.paypal.state.created[0].body.primary_recipients[0].billing_info.email_address, 'priya@example.com');
  assert.equal(t.paypal.state.created[0].body.detail.note, 'Thanks!');
  assert.equal(t.paypal.state.created[0].requestId, id);

  const again = await t.call('POST', `/api/proposals/${id}/approve`, { today: TODAY });
  assert.equal(again.status, 200);
  assert.equal(t.paypal.state.created.length, 1);
  assert.equal(t.paypal.state.sent.length, 1);

  const audit = await t.call('GET', '/api/audit');
  assert.ok(audit.json.entries.some((e) => e.type === 'invoice_sent'));
  await t.close();
});

test('approve: if sending fails after the draft exists, a retry sends without creating a second invoice', async () => {
  const paypal = fakePayPal();
  paypal.state.failSendOnce = true;
  const ai = scriptedAi([{ calls: [{ name: 'prepare_invoice', args: invoiceArgs() }] }, { text: 'ok' }]);
  const t = await start({ ai, paypal });
  const id = (await chat(t.call, 'go')).json.proposals[0].id;

  const first = await t.call('POST', `/api/proposals/${id}/approve`, { today: TODAY });
  assert.equal(first.status, 502);
  assert.match(first.json.error, /draft invoice was created/);
  assert.equal(paypal.state.created.length, 1);

  const second = await t.call('POST', `/api/proposals/${id}/approve`, { today: TODAY });
  assert.equal(second.status, 200);
  assert.equal(paypal.state.created.length, 1);
  assert.equal(paypal.state.sent.length, 1);
  await t.close();
});

test('guards: high-value needs explicit confirmation; over the cap is blocked by the server', async () => {
  const high = invoiceArgs({ line_items: [{ description: 'Big project', quantity: 1, unit_price: 1500 }] });
  const huge = invoiceArgs({ line_items: [{ description: 'Enormous project', quantity: 1, unit_price: 9000 }] });
  const ai = scriptedAi([{ calls: [{ name: 'prepare_invoice', args: high }, { name: 'prepare_invoice', args: huge }] }, { text: 'two ready' }]);
  const t = await start({ ai });
  const { json } = await chat(t.call, 'two big ones');
  const [hi, hu] = json.proposals;
  assert.equal(hi.requiresConfirm, true);
  assert.ok(hu.blockers.length > 0);

  const noConfirm = await t.call('POST', `/api/proposals/${hi.id}/approve`, { today: TODAY });
  assert.equal(noConfirm.status, 422);
  assert.equal(noConfirm.json.code, 'CONFIRM_REQUIRED');
  assert.equal(t.paypal.state.created.length, 0);

  const confirmed = await t.call('POST', `/api/proposals/${hi.id}/approve`, { today: TODAY, confirmHighValue: true });
  assert.equal(confirmed.status, 200);

  const blocked = await t.call('POST', `/api/proposals/${hu.id}/approve`, { today: TODAY, confirmHighValue: true });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.code, 'BLOCKED');
  assert.equal(t.paypal.state.created.length, 1);
  await t.close();
});

test('guards cannot be bypassed by editing the approval form (server re-validates)', async () => {
  const ai = scriptedAi([{ calls: [{ name: 'prepare_invoice', args: invoiceArgs() }] }, { text: 'ok' }]);
  const t = await start({ ai });
  const id = (await chat(t.call, 'go')).json.proposals[0].id;
  const res = await t.call('POST', `/api/proposals/${id}/approve`, {
    today: TODAY,
    edits: { lineItems: [{ description: 'Sneaky', quantity: 1, unitPrice: 99999 }] },
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.code, 'BLOCKED');
  assert.equal(t.paypal.state.created.length, 0);
  await t.close();
});

test('reject: a discarded proposal can no longer be approved', async () => {
  const ai = scriptedAi([{ calls: [{ name: 'prepare_invoice', args: invoiceArgs() }] }, { text: 'ok' }]);
  const t = await start({ ai });
  const id = (await chat(t.call, 'go')).json.proposals[0].id;
  assert.equal((await t.call('POST', `/api/proposals/${id}/reject`, {})).json.proposal.status, 'rejected');
  const res = await t.call('POST', `/api/proposals/${id}/approve`, { today: TODAY });
  assert.equal(res.status, 409);
  assert.equal(t.paypal.state.created.length, 0);
  assert.equal((await t.call('POST', '/api/proposals/doesnotexist/approve', {})).status, 404);
  await t.close();
});

test('prepare_invoice: invalid AI output is returned to the model as an error, not turned into a proposal', async () => {
  const ai = scriptedAi([{ calls: [{ name: 'prepare_invoice', args: { client_name: 'X Y', line_items: [] } }] }, { text: 'What should I bill?' }]);
  const t = await start({ ai });
  const res = await chat(t.call, 'invoice X');
  assert.equal(res.json.proposals.length, 0);
  assert.equal(res.json.reply, 'What should I bill?');
  assert.match(t.ai.seen[1][2].parts[0].functionResponse.response.error, /line item/);
  await t.close();
});

const sentInvoice = (id, number, name, email, due, amount, status = 'SENT') => ({
  id,
  status,
  detail: { invoice_number: number, currency_code: 'USD', payment_term: { due_date: due } },
  primary_recipients: [{ billing_info: { name: { given_name: name.split(' ')[0], surname: name.split(' ')[1] }, email_address: email } }],
  amount: { currency_code: 'USD', value: amount },
  due_amount: { currency_code: 'USD', value: status === 'PAID' ? '0.00' : amount },
});

test('dashboard + list_invoices tool + reminder flow (friendly vs final tone by lateness)', async () => {
  const late = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const paypal = fakePayPal([
    sentInvoice('INV2-A', '0001', 'Ravi Kumar', 'ravi@example.com', late, '300.00'),
    sentInvoice('INV2-B', '0002', 'Mia Chen', 'mia@example.com', soon, '120.00'),
    sentInvoice('INV2-C', '0003', 'Paid Person', 'paid@example.com', late, '80.00', 'PAID'),
  ]);

  const dashApp = await start({ paypal });
  const dash = await dashApp.call('GET', `/api/invoices?today=${TODAY}`);
  await dashApp.close();
  assert.equal(dash.status, 200);
  assert.equal(dash.json.stats.overdueCount, 1);
  assert.equal(dash.json.stats.outstanding, 420);
  assert.equal(dash.json.invoices[0].status, 'overdue');

  const ai = scriptedAi([
    { calls: [{ name: 'list_invoices', args: { status: 'overdue' } }] },
    { calls: [{ name: 'draft_reminder', args: { invoice_id: 'INV2-A', message: 'Please pay invoice 0001.' } }] },
    { text: 'Drafted a reminder for Ravi.' },
  ]);
  const t = await start({ paypal, ai });
  const res = await chat(t.call, 'remind overdue clients');
  assert.equal(res.json.proposals.length, 1);
  const rem = res.json.proposals[0];
  assert.equal(rem.type, 'reminder');
  assert.equal(rem.reminder.tone, 'final');
  assert.equal(rem.reminder.invoiceId, 'INV2-A');
  const listResult = t.ai.seen[1][2].parts[0].functionResponse.response;
  assert.equal(listResult.invoices.length, 1);
  assert.equal(listResult.invoices[0].client, 'Ravi Kumar');
  assert.equal(paypal.state.reminded.length, 0);

  const ok = await t.call('POST', `/api/proposals/${rem.id}/approve`, { edits: { subject: 'Overdue: 0001', message: 'Edited message' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(paypal.state.reminded[0], { id: 'INV2-A', subject: 'Overdue: 0001', note: 'Edited message' });
  await t.close();
});

test('reminders are refused for paid invoices', async () => {
  const paypal = fakePayPal([sentInvoice('INV2-P', '0009', 'Paid Person', 'p@example.com', TODAY, '10.00', 'PAID')]);
  const ai = scriptedAi([{ calls: [{ name: 'draft_reminder', args: { invoice_id: 'INV2-P', message: 'pay up' } }] }, { text: 'That one is paid.' }]);
  const t = await start({ paypal, ai });
  const res = await chat(t.call, 'remind paid person');
  assert.equal(res.json.proposals.length, 0);
  assert.match(t.ai.seen[1][2].parts[0].functionResponse.response.error, /paid/);
  await t.close();
});

test('API hygiene: validation, rate limiting, security headers, error shapes', async () => {
  const t = await start();
  assert.equal((await t.call('POST', '/api/chat', { messages: [] })).status, 400);
  assert.equal((await t.call('POST', '/api/chat', { messages: [{ role: 'assistant', text: 'hi' }] })).status, 400);
  const health = await t.call('GET', '/api/health');
  assert.equal(health.json.sandbox, true);
  assert.ok(!JSON.stringify(health.json).includes('"k"'));
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await t.call('GET', '/api/nope')).status, 404);
  const page = await fetch(t.base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Freelance CFO/);
  assert.equal((await fetch(`${t.base}/main.js`)).status, 200);
  await t.close();

  const limited = await start({ cfg: loadConfig({ PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's', GEMINI_API_KEY: 'k', CHAT_RATE_PER_MIN: '2' }) });
  assert.equal((await chat(limited.call, 'one')).status, 200);
  assert.equal((await chat(limited.call, 'two')).status, 200);
  const third = await chat(limited.call, 'three');
  assert.equal(third.status, 429);
  assert.ok(third.headers.get('retry-after'));
  await limited.close();
});

/* ------------------------------------------------------------------------------
   Wire test: the REAL PayPalClient and GeminiClient talking HTTP to local mock
   servers, so the whole stack (REST shapes, headers, JSON) is exercised end to end.
-------------------------------------------------------------------------------- */

function mockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      handler(req, raw, send);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('wire: Gemini function-calling round trip + PayPal create/send over real HTTP', async () => {
  const paypalSeen = [];
  const pp = await mockServer((req, raw, send) => {
    paypalSeen.push({ method: req.method, url: req.url, auth: req.headers.authorization, reqId: req.headers['paypal-request-id'], body: raw });
    if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'T', expires_in: 3600 });
    if (req.method === 'GET' && req.url.startsWith('/v2/invoicing/invoices?')) return send(200, { total_pages: 1, items: [] });
    if (req.method === 'POST' && req.url === '/v2/invoicing/invoices') return send(201, { rel: 'self', href: `${pp.url}/v2/invoicing/invoices/INV2-WIRE`, method: 'GET' });
    if (req.url === '/v2/invoicing/invoices/INV2-WIRE/send') return send(200, { rel: 'invoice', href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-WIRE' });
    return send(404, { name: 'RESOURCE_NOT_FOUND', message: 'nope' });
  });

  let geminiCalls = 0;
  const gm = await mockServer((req, raw, send) => {
    geminiCalls += 1;
    assert.equal(req.headers['x-goog-api-key'], 'GKEY');
    assert.equal(req.url, '/v1beta/models/gemini-test:generateContent');
    const body = JSON.parse(raw);
    assert.ok(body.tools[0].functionDeclarations.some((d) => d.name === 'prepare_invoice'));
    if (geminiCalls === 1) {
      return send(200, {
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'prepare_invoice', args: invoiceArgs() }, thoughtSignature: 'S1' }] }, finishReason: 'STOP' }],
      });
    }
    assert.equal(body.contents.at(-1).parts[0].functionResponse.name, 'prepare_invoice');
    assert.equal(body.contents.at(-2).parts[0].thoughtSignature, 'S1');
    return send(200, { candidates: [{ content: { role: 'model', parts: [{ text: 'Prepared. Please review.' }] }, finishReason: 'STOP' }] });
  });

  const cfg = loadConfig({
    PAYPAL_CLIENT_ID: 'cid',
    PAYPAL_CLIENT_SECRET: 'sec',
    PAYPAL_BASE_URL: `${pp.url}/sandbox-test`.replace('/sandbox-test', ''),
    GEMINI_API_KEY: 'GKEY',
    GEMINI_MODEL: 'gemini-test',
    GEMINI_BASE_URL: `${gm.url}/v1beta`,
  });
  // The mock PayPal URL has no "sandbox" in it; allow it explicitly for this local test only.
  cfg.allowLive = true;

  const paypal = new PayPalClient({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret, baseUrl: cfg.paypal.baseUrl });
  const ai = new GeminiClient(cfg.gemini);
  const t = await start({ paypal, ai, cfg });

  const res = await chat(t.call, 'Invoice Priya 3 pages at $50 + $100 hosting, due in 10 days, priya@example.com');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.reply, 'Prepared. Please review.');
  const p = res.json.proposals[0];

  const approved = await t.call('POST', `/api/proposals/${p.id}/approve`, { today: TODAY });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(approved.json.proposal.result.invoiceId, 'INV2-WIRE');
  assert.equal(approved.json.proposal.result.link, 'https://www.sandbox.paypal.com/invoice/p/#INV2-WIRE');

  const create = paypalSeen.find((r) => r.method === 'POST' && r.url === '/v2/invoicing/invoices');
  assert.equal(create.auth, 'Bearer T');
  assert.equal(create.reqId, p.id);
  const sent = JSON.parse(create.body);
  assert.equal(sent.items.length, 2);
  assert.equal(sent.items[0].unit_amount.value, '50.00');
  const sendCall = paypalSeen.find((r) => r.url.endsWith('/send'));
  assert.deepEqual(JSON.parse(sendCall.body), { send_to_recipient: true, send_to_invoicer: true });

  await t.close();
  for (const m of [pp, gm]) {
    m.server.closeAllConnections();
    m.server.close();
  }
});