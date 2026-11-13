import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import {
  computeClients,
  computeStats,
  normalizeInvoiceDetail,
  normalizePayPalInvoice,
  normalizePaymentInput,
  normalizeSettings,
  reminderTemplate,
} from '../src/invoices.js';

const TODAY = new Date().toISOString().slice(0, 10);
const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const baseEnv = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', GEMINI_API_KEY: 'k', CHAT_RATE_PER_MIN: '1000', ACTION_RATE_PER_MIN: '1000' };

const raw = (id, number, name, email, due, amount, status = 'SENT', extra = {}) => ({
  id,
  status,
  detail: { invoice_number: number, currency_code: 'USD', invoice_date: daysFromNow(-40), payment_term: { due_date: due }, ...extra.detail },
  primary_recipients: [{ billing_info: { name: { given_name: name.split(' ')[0], surname: name.split(' ')[1] }, email_address: email } }],
  amount: { currency_code: 'USD', value: amount },
  due_amount: { currency_code: 'USD', value: status === 'PAID' ? '0.00' : amount },
  items: [{ name: 'Work', quantity: '2', unit_amount: { currency_code: 'USD', value: (Number(amount) / 2).toFixed(2) } }],
  ...extra.top,
});

function fakePayPal(initial) {
  const s = { invoices: [...initial], created: [], sent: [], reminded: [], payments: [], cancelled: [] };
  return {
    s,
    scope: 'https://uri.paypal.com/services/invoicing',
    async getToken() { return 't'; },
    async listInvoices() { return s.invoices; },
    async getInvoice(id) {
      const inv = s.invoices.find((i) => i.id === id);
      if (!inv) { const { PayPalError } = await import('../src/paypal.js'); throw new PayPalError('PayPal said: not found', { status: 404 }); }
      return inv;
    },
    async createDraftInvoice(body, requestId) { const id = `NEW-${s.created.length + 1}`; s.created.push({ id, body, requestId }); return { id, href: '' }; },
    async sendInvoice(id) { s.sent.push(id); return { href: '' }; },
    async remindInvoice(id, p) { s.reminded.push({ id, ...p }); return { ok: true }; },
    async recordPayment(id, p) { s.payments.push({ id, ...p }); return { paymentId: 'PAY-1' }; },
    async cancelInvoice(id, p) { s.cancelled.push({ id, ...p }); return { ok: true }; },
  };
}

function scriptedAi(script) {
  const seen = [];
  let i = 0;
  return {
    seen,
    async generate(req) {
      seen.push(JSON.parse(JSON.stringify(req.contents)));
      const step = script[Math.min(i++, script.length - 1)];
      const parts = step.calls ? step.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) : [{ text: step.text }];
      return { content: { role: 'model', parts }, parts, text: step.text || '', functionCalls: step.calls || [], finishReason: 'STOP', model: 'fake' };
    },
  };
}

async function start({ invoices = [], ai = scriptedAi([{ text: 'ok' }]), env = {}, store } = {}) {
  const paypal = fakePayPal(invoices);
  const cfg = loadConfig({ ...baseEnv, ...env });
  const app = createApp({ config: cfg, paypal, ai, store: store || new Store({ persist: false }) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null), res };
  };
  return { call, paypal, ai, cfg, base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const late = raw('INV-LATE', '0001', 'Ravi Kumar', 'ravi@example.com', daysFromNow(-30), '300.00');
const soon = raw('INV-SOON', '0002', 'Mia Chen', 'mia@example.com', daysFromNow(5), '120.00');
const paid = raw('INV-PAID', '0003', 'Paid Person', 'paid@example.com', daysFromNow(-60), '80.00', 'PAID');
const mildLate = raw('INV-MILD', '0004', 'Ravi Kumar', 'ravi@example.com', daysFromNow(-3), '50.00');

/* ------------------------------- pure logic -------------------------------- */

test('stats: aging buckets and collection rate', () => {
  const rows = [late, soon, paid, mildLate].map((i) => normalizePayPalInvoice(i, TODAY));
  const s = computeStats(rows);
  assert.equal(s.aging.notDue, 120);
  assert.equal(s.aging.d1to7, 50);
  assert.equal(s.aging.d22plus, 300);
  assert.equal(s.outstanding, 470);
  assert.equal(s.collected, 80);
  assert.equal(s.collectionRate, 15); // 80 / (80 + 470)
});

test('clients: grouped by email with totals and overdue counts', () => {
  const rows = [late, soon, paid, mildLate].map((i) => normalizePayPalInvoice(i, TODAY));
  const clients = computeClients(rows);
  assert.equal(clients[0].name, 'Ravi Kumar');
  assert.equal(clients[0].invoiceCount, 2);
  assert.equal(clients[0].outstanding, 350);
  assert.equal(clients[0].overdueCount, 2);
  assert.equal(clients.find((c) => c.name === 'Paid Person').paid, 80);
});

test('invoice detail: items, payments and paid amount', () => {
  const inv = raw('X', '9', 'Ann Lee', 'a@b.com', daysFromNow(5), '100.00', 'PARTIALLY_PAID', {
    top: { due_amount: { currency_code: 'USD', value: '40.00' }, payments: { transactions: [{ method: 'CASH', payment_date: '2026-11-01', amount: { currency_code: 'USD', value: '60.00' }, note: 'in person' }] } },
  });
  const d = normalizeInvoiceDetail(inv, TODAY);
  assert.equal(d.items[0].totalCents, 10000);
  assert.equal(d.payments[0].amountCents, 6000);
  assert.equal(d.paidCents, 6000);
  assert.equal(d.category, 'unpaid');
});

test('payment + settings validation', () => {
  assert.equal(normalizePaymentInput({}, { today: TODAY, dueCents: 5000 }).value.amountCents, 5000);
  assert.match(normalizePaymentInput({ amount: 60 }, { today: TODAY, dueCents: 5000 }).errors.join(' '), /more than the amount still due/);
  assert.match(normalizePaymentInput({ date: daysFromNow(3) }, { today: TODAY, dueCents: 5000 }).errors.join(' '), /future/);
  assert.match(normalizePaymentInput({ method: 'BITCOIN' }, { today: TODAY, dueCents: 5000 }).errors.join(' '), /method/);
  assert.equal(normalizeSettings({ maxInvoiceAmount: 5000, highValueThreshold: 1000, defaultDueDays: 14 }).ok, true);
  assert.equal(normalizeSettings({ maxInvoiceAmount: 100, highValueThreshold: 1000, defaultDueDays: 14 }).ok, false);
  assert.equal(normalizeSettings({ maxInvoiceAmount: 100, highValueThreshold: 10, defaultDueDays: -1 }).ok, false);
});

test('reminder templates escalate', () => {
  const base = { clientName: 'Ravi Kumar', number: '0001', amountText: 'USD 300.00', dueDate: '2026-10-01' };
  assert.match(reminderTemplate({ ...base, tone: 'friendly', daysOverdue: 0 }), /friendly reminder/);
  assert.match(reminderTemplate({ ...base, tone: 'firm', daysOverdue: 12 }), /12 days overdue/);
  assert.match(reminderTemplate({ ...base, tone: 'final', daysOverdue: 40 }), /final reminder/);
});

/* --------------------------------- auth ------------------------------------ */

test('auth: password-protected deployment blocks the API until sign-in', async () => {
  const t = await start({ invoices: [soon], env: { APP_PASSWORD: 'open-sesame' } });
  assert.equal((await t.call('GET', '/api/session')).json.authenticated, false);
  assert.equal((await t.call('GET', '/api/invoices')).status, 401);
  assert.equal((await t.call('POST', '/api/chat', { messages: [{ role: 'user', text: 'hi' }] })).status, 401);
  assert.equal((await t.call('GET', '/api/health')).status, 200); // health stays public for the host
  assert.equal((await t.call('POST', '/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await t.call('POST', '/api/login', { password: 'open-sesame' })).status, 200);
  assert.equal((await t.call('GET', '/api/invoices')).status, 200);
  assert.equal((await t.call('GET', '/api/session')).json.authenticated, true);
  await t.call('POST', '/api/logout', {});
  assert.equal((await t.call('GET', '/api/invoices')).status, 401); // logout cleared the session cookie
  const page = await fetch(`${t.base}/login`);
  assert.equal(page.status, 200); // the page shell itself is public
  await t.close();
});

test('auth: forged or expired cookies are rejected, and login is rate limited', async () => {
  const t = await start({ env: { APP_PASSWORD: 'pw' } });
  const forged = await fetch(`${t.base}/api/invoices`, { headers: { cookie: `fc_session=${Date.now() + 100000}.deadbeef` } });
  assert.equal(forged.status, 401);
  let last;
  for (let i = 0; i < 10; i++) last = await t.call('POST', '/api/login', { password: 'nope' });
  assert.equal(last.status, 429);
  await t.close();
});

/* -------------------------------- pages' APIs ------------------------------ */

test('SPA routes serve the app shell; unknown API routes 404; status endpoint reports health', async () => {
  const t = await start({ invoices: [soon] });
  for (const path of ['/invoices', '/invoices/INV-SOON', '/settings', '/approvals']) {
    const r = await fetch(t.base + path);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Freelance CFO/);
  }
  assert.equal((await t.call('GET', '/api/nope')).status, 404);
  const st = (await t.call('GET', '/api/status')).json;
  assert.equal(st.paypal.connected, true);
  assert.equal(st.paypal.invoicingPermission, true);
  assert.equal(st.mode, 'sandbox');
  assert.deepEqual(st.ai.models.length > 0, true);
  await t.close();
});

test('invoice detail and clients endpoints', async () => {
  const t = await start({ invoices: [late, soon, paid] });
  const d = (await t.call('GET', `/api/invoices/INV-LATE?today=${TODAY}`)).json.invoice;
  assert.equal(d.number, '0001');
  assert.equal(d.status, 'overdue');
  assert.equal(d.items[0].total, 300);
  assert.match(d.clientLink, /sandbox\.paypal\.com\/invoice\/p\/#INV-LATE/);
  assert.equal((await t.call('GET', '/api/invoices/NOPE')).status, 422);
  const clients = (await t.call('GET', `/api/clients?today=${TODAY}`)).json.clients;
  assert.equal(clients.length, 3);
  await t.close();
});

test('settings: validated, applied immediately by the guards, and audited', async () => {
  const t = await start();
  assert.equal((await t.call('PUT', '/api/settings', { maxInvoiceAmount: 10, highValueThreshold: 50, defaultDueDays: 14 })).status, 422);
  const ok = await t.call('PUT', '/api/settings', { maxInvoiceAmount: 200, highValueThreshold: 100, defaultDueDays: 7 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.limits.maxInvoiceAmount, 200);

  const blank = (await t.call('POST', '/api/invoices/new', { today: TODAY })).json.proposal;
  assert.equal(blank.invoice.dueDate, new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  const blocked = await t.call('POST', `/api/proposals/${blank.id}/approve`, {
    today: TODAY,
    edits: { clientName: 'Big Spender', clientEmail: 'big@example.com', lineItems: [{ description: 'x', quantity: 1, unitPrice: 500 }] },
  });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.code, 'BLOCKED');
  assert.equal(t.paypal.s.created.length, 0);
  assert.ok((await t.call('GET', '/api/audit')).json.entries.some((e) => e.type === 'settings_changed'));
  await t.close();
});

test('manual new-invoice flow: blank proposal, edits, approval', async () => {
  const t = await start();
  const blank = (await t.call('POST', '/api/invoices/new', { today: TODAY })).json.proposal;
  assert.equal(blank.status, 'pending');
  const empty = await t.call('POST', `/api/proposals/${blank.id}/approve`, { today: TODAY });
  assert.equal(empty.status, 422); // nothing filled in yet
  const ok = await t.call('POST', `/api/proposals/${blank.id}/approve`, {
    today: TODAY,
    edits: { clientName: 'Sam Lee', clientEmail: 'sam@example.com', lineItems: [{ description: 'Consulting', quantity: 2, unitPrice: 75 }] },
  });
  assert.equal(ok.status, 200);
  assert.equal(t.paypal.s.created[0].body.items[0].unit_amount.value, '75.00');
  assert.equal(t.paypal.s.sent.length, 1);
  await t.close();
});

test('reminder button: template tone follows lateness, nothing is sent until approved', async () => {
  const t = await start({ invoices: [late, soon, paid] });
  const lateP = (await t.call('POST', '/api/invoices/INV-LATE/remind', { today: TODAY })).json.proposal;
  assert.equal(lateP.reminder.tone, 'final');
  assert.match(lateP.reminder.message, /30 days/);
  const soonP = (await t.call('POST', '/api/invoices/INV-SOON/remind', { today: TODAY })).json.proposal;
  assert.equal(soonP.reminder.tone, 'friendly');
  assert.equal((await t.call('POST', '/api/invoices/INV-PAID/remind', { today: TODAY })).status, 409);
  assert.equal(t.paypal.s.reminded.length, 0);
  assert.equal((await t.call('POST', `/api/proposals/${lateP.id}/approve`, { edits: { subject: 'Hello', message: 'Please pay.' } })).status, 200);
  assert.deepEqual(t.paypal.s.reminded, [{ id: 'INV-LATE', subject: 'Hello', note: 'Please pay.' }]);
  assert.equal((await t.call('GET', '/api/proposals?status=pending')).json.proposals.length, 1); // the friendly one
  await t.close();
});

test('record payment: validated against what is still due, then sent to PayPal', async () => {
  const t = await start({ invoices: [late] });
  const p = (await t.call('POST', '/api/invoices/INV-LATE/payment', { today: TODAY, amount: 100, method: 'cash' })).json.proposal;
  assert.equal(p.payment.amount, 100);
  assert.equal(p.payment.dueAmount, 300);
  assert.equal((await t.call('POST', '/api/invoices/INV-LATE/payment', { today: TODAY, amount: 999 })).status, 422);
  const tooMuch = await t.call('POST', `/api/proposals/${p.id}/approve`, { today: TODAY, edits: { amount: 999 } });
  assert.equal(tooMuch.status, 422);
  assert.equal(t.paypal.s.payments.length, 0);
  const ok = await t.call('POST', `/api/proposals/${p.id}/approve`, { today: TODAY, edits: { amount: 100, note: 'cash in hand' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(t.paypal.s.payments[0], { id: 'INV-LATE', method: 'CASH', date: TODAY, amount: '100.00', currency: 'USD', note: 'cash in hand' });
  await t.close();
});

test('cancel invoice: only for open invoices, only after approval', async () => {
  const t = await start({ invoices: [late, paid] });
  assert.equal((await t.call('POST', '/api/invoices/INV-PAID/cancel', { today: TODAY })).status, 409);
  const p = (await t.call('POST', '/api/invoices/INV-LATE/cancel', { today: TODAY })).json.proposal;
  assert.match(p.cancel.note, /cancelled/);
  assert.equal(t.paypal.s.cancelled.length, 0);
  assert.equal((await t.call('POST', `/api/proposals/${p.id}/approve`, {})).status, 200);
  assert.equal(t.paypal.s.cancelled[0].id, 'INV-LATE');
  assert.ok((await t.call('GET', '/api/audit')).json.entries.some((e) => e.type === 'invoice_cancelled'));
  await t.close();
});

/* ------------------------------ the AI agent -------------------------------- */

test('agent: collections review drafts one reminder per overdue invoice and returns a visible trace', async () => {
  const ai = scriptedAi([
    { calls: [{ name: 'list_invoices', args: { status: 'unpaid' } }] },
    { calls: [
      { name: 'draft_reminder', args: { invoice_id: 'INV-LATE', message: 'Final notice for 0001.' } },
      { name: 'draft_reminder', args: { invoice_id: 'INV-MILD', message: 'Gentle nudge for 0004.' } },
    ] },
    { text: 'Prepared 2 reminders. Skipped Mia Chen because her invoice is not due yet.' },
  ]);
  const t = await start({ invoices: [late, soon, mildLate], ai });
  const res = await t.call('POST', '/api/chat', { messages: [{ role: 'user', text: 'review my collections' }], today: TODAY });
  assert.equal(res.status, 200);
  assert.equal(res.json.proposals.length, 2);
  assert.deepEqual(res.json.proposals.map((p) => p.reminder.tone).sort(), ['final', 'friendly']);
  assert.equal(res.json.trace.length, 3);
  assert.match(res.json.trace[0].summary, /Checked PayPal: 3 matching/);
  assert.match(res.json.trace[1].summary, /Drafted a final reminder/);
  assert.equal(t.paypal.s.reminded.length, 0);
  await t.close();
});

test('agent: summary and record_payment tools work, and prepared payments still need approval', async () => {
  const ai = scriptedAi([
    { calls: [{ name: 'get_summary', args: {} }] },
    { calls: [{ name: 'record_payment', args: { invoice_id: 'INV-LATE', method: 'BANK_TRANSFER' } }] },
    { text: 'You are owed $470. I prepared the payment record for Ravi.' },
  ]);
  const t = await start({ invoices: [late, soon, paid, mildLate], ai });
  const res = await t.call('POST', '/api/chat', { messages: [{ role: 'user', text: 'Ravi paid by bank transfer' }], today: TODAY });
  assert.equal(res.json.proposals[0].type, 'payment');
  const summary = t.ai.seen[1][2].parts[0].functionResponse.response;
  assert.equal(summary.outstanding, 470);
  assert.equal(summary.top_debtors[0].client, 'Ravi Kumar');
  assert.equal(t.paypal.s.payments.length, 0);
  await t.close();
});

test('agent: bad tool input is returned to the model, and a runaway agent is capped', async () => {
  const many = Array.from({ length: 12 }, () => ({ name: 'draft_reminder', args: { invoice_id: 'INV-LATE', message: 'pay' } }));
  const ai = scriptedAi([{ calls: many }, { text: 'done' }]);
  const t = await start({ invoices: [late], ai });
  const res = await t.call('POST', '/api/chat', { messages: [{ role: 'user', text: 'spam' }], today: TODAY });
  assert.equal(res.json.proposals.length, 8);
  assert.ok(res.json.trace.some((x) => !x.ok && /At most 8 proposals/.test(x.summary)));

  const ai2 = scriptedAi([{ calls: [{ name: 'draft_reminder', args: { invoice_id: 'does-not-exist', message: 'x' } }] }, { text: 'I could not find that invoice.' }]);
  const t2 = await start({ invoices: [late], ai: ai2 });
  const r2 = await t2.call('POST', '/api/chat', { messages: [{ role: 'user', text: 'x' }], today: TODAY });
  assert.equal(r2.json.proposals.length, 0);
  assert.match(t2.ai.seen[1][2].parts[0].functionResponse.response.error, /No invoice with id/);
  await t.close();
  await t2.close();
});