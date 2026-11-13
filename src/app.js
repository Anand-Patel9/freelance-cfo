// The HTTP application. Built as a factory (createApp) so tests can inject fake PayPal / AI clients.
//
// Flow:  chat -> agent (Gemini) -> tools -> PROPOSAL (nothing changes in PayPal)
//        user clicks Approve -> server re-validates, enforces guards -> PayPal call

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { isSandbox } from './config.js';
import { runAgent } from './agent.js';
import { createAuth } from './auth.js';
import { AiError } from './gemini.js';
import { PayPalError } from './paypal.js';
import {
  AppError,
  PAYMENT_METHODS,
  addDays,
  buildPayPalInvoice,
  clean,
  computeClients,
  computeStats,
  daysBetween,
  evaluateGuards,
  formatMoney,
  isIsoDate,
  normalizeInvoiceDetail,
  normalizeInvoiceInput,
  normalizePayPalInvoice,
  normalizePaymentInput,
  normalizeSettings,
  reminderTemplate,
  reminderTone,
  sortInvoices,
  toInvoiceView,
} from './invoices.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SRC_DIR, '..', 'public');
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SRC_DIR, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '1.0.0';
  }
})();
const PAYPAL_WEB = { sandbox: 'https://www.sandbox.paypal.com', live: 'https://www.paypal.com' };
const INVOICE_CACHE_MS = 10_000;
const MAX_PROPOSALS_PER_CHAT = 8;
const PUBLIC_API = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);

export function createApp({ config, paypal, ai, store, now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Saved safety limits (edited on the Settings page) override the .env defaults.
  const defaults = { ...config.limits };
  const saved = normalizeSettings({ ...defaults, ...store.loadSettings() });
  if (saved.ok) Object.assign(config.limits, saved.value);

  const auth = createAuth({ password: config.appPassword, secret: config.sessionSecret, now });

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  /* ------------------------------ rate limiting ----------------------------- */

  function rateLimit({ max, windowMs = 60_000 }) {
    const hits = new Map();
    return (req, res, next) => {
      const t = now();
      if (hits.size > 5000) hits.clear();
      const key = req.ip || 'unknown';
      const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: 'Too many requests. Please slow down for a moment.', code: 'RATE_LIMITED' });
      }
      recent.push(t);
      hits.set(key, recent);
      next();
    };
  }
  const chatLimiter = rateLimit({ max: config.limits.chatPerMinute });
  const actionLimiter = rateLimit({ max: config.limits.actionPerMinute });
  const loginLimiter = rateLimit({ max: 8 });

  /* --------------------------------- helpers -------------------------------- */

  const sandbox = isSandbox(config);

  function resolveToday(input) {
    const server = new Date(now()).toISOString().slice(0, 10);
    if (typeof input === 'string' && isIsoDate(input) && Math.abs(daysBetween(server, input)) <= 2) return input;
    return server;
  }

  let invoiceCache = { at: 0, data: null };
  async function loadInvoices({ force = false } = {}) {
    if (!force && invoiceCache.data && now() - invoiceCache.at < INVOICE_CACHE_MS) return invoiceCache.data;
    const raw = await paypal.listInvoices();
    invoiceCache = { at: now(), data: raw };
    return raw;
  }
  const invalidateInvoices = () => {
    invoiceCache = { at: 0, data: null };
  };

  /** Finds one invoice (normalised) by PayPal id or invoice number. */
  async function findInvoice(idOrNumber, today) {
    const id = clean(idOrNumber, 100);
    if (!id) throw new AppError('An invoice id is required.', { status: 400 });
    for (const force of [false, true]) {
      const raw = await loadInvoices({ force });
      const found = raw.map((i) => normalizePayPalInvoice(i, today)).find((i) => i.id === id || i.number === id);
      if (found) return found;
    }
    throw new AppError(`No invoice with id "${id}".`, { status: 404, code: 'NOT_FOUND' });
  }

  async function guardContext() {
    let knownEmails = null;
    try {
      const raw = await loadInvoices();
      knownEmails = new Set(
        raw.map((i) => String(i?.primary_recipients?.[0]?.billing_info?.email_address || '').toLowerCase()).filter(Boolean)
      );
    } catch {
      /* guards degrade gracefully if PayPal can't be listed */
    }
    return { limits: config.limits, knownEmails, recentSent: store.recentSentInvoices(), now: now() };
  }

  function payerLink(id, href) {
    if (href && !/\/v2\/invoicing\//.test(href) && /^https:\/\//.test(href)) return href;
    return `${sandbox ? PAYPAL_WEB.sandbox : PAYPAL_WEB.live}/invoice/p/#${id}`;
  }

  function proposalView(p) {
    const base = {
      id: p.id,
      type: p.type,
      status: p.status,
      error: p.error,
      result: p.result,
      warnings: p.warnings || [],
      blockers: p.blockers || [],
      requiresConfirm: Boolean(p.requiresConfirm),
      createdAt: p.createdAt,
    };
    if (p.type === 'invoice') return { ...base, invoice: toInvoiceView(p.value) };
    return { ...base, [p.type]: p.value };
  }

  const invoiceRow = (r) => ({
    id: r.id,
    number: r.number,
    clientName: r.clientName,
    clientEmail: r.clientEmail,
    status: r.category,
    currency: r.currency,
    total: r.totalCents / 100,
    due: r.dueCents / 100,
    dueDate: r.dueDate,
    invoiceDate: r.invoiceDate,
    daysOverdue: r.daysOverdue,
  });

  /* --------------------------- proposal factories --------------------------- */
  // Used by BOTH the AI tools and the manual buttons in the UI, so the same rules apply.

  function makeReminderProposal(found, { message, subject, ctx }) {
    if (found.category !== 'unpaid' && found.category !== 'overdue') {
      throw new AppError(`Invoice ${found.number} is ${found.category}, so a payment reminder makes no sense.`, { status: 409, code: 'NOT_REMINDABLE' });
    }
    const tone = reminderTone(found.daysOverdue);
    const amountText = formatMoney(found.dueCents, found.currency);
    const body =
      clean(message, 1000) ||
      reminderTemplate({ tone, clientName: found.clientName, number: found.number, amountText, dueDate: found.dueDate, daysOverdue: found.daysOverdue });
    const title =
      clean(subject, 200) || (found.category === 'overdue' ? `Reminder: invoice ${found.number} is overdue` : `Friendly reminder: invoice ${found.number}`);
    const proposal = store.createProposal({
      type: 'reminder',
      value: {
        invoiceId: found.id, number: found.number, clientName: found.clientName, clientEmail: found.clientEmail,
        amount: found.dueCents / 100, currency: found.currency, dueDate: found.dueDate, daysOverdue: found.daysOverdue,
        tone, subject: title, message: body,
      },
    });
    ctx?.proposalIds.push(proposal.id);
    store.audit('proposal_created', `Drafted ${tone} reminder for ${found.number} (${found.clientName}), waiting for approval`, { proposalId: proposal.id });
    return proposal;
  }

  function makePaymentProposal(found, raw, today, ctx) {
    if (found.category !== 'unpaid' && found.category !== 'overdue') {
      throw new AppError(`Invoice ${found.number} is ${found.category}, so no payment can be recorded.`, { status: 409, code: 'NOT_PAYABLE' });
    }
    const result = normalizePaymentInput(raw, { today, dueCents: found.dueCents });
    if (!result.ok) throw new AppError(result.errors.join(' '), { status: 422, code: 'INVALID' });
    const proposal = store.createProposal({
      type: 'payment',
      value: {
        invoiceId: found.id, number: found.number, clientName: found.clientName, currency: found.currency,
        dueAmount: found.dueCents / 100, amount: result.value.amountCents / 100,
        method: result.value.method, date: result.value.date, note: result.value.note,
      },
    });
    ctx?.proposalIds.push(proposal.id);
    store.audit('proposal_created', `Prepared payment record for ${found.number} (${formatMoney(result.value.amountCents, found.currency)}), waiting for approval`, { proposalId: proposal.id });
    return proposal;
  }

  function makeCancelProposal(found) {
    if (found.category !== 'unpaid' && found.category !== 'overdue') {
      throw new AppError(`Invoice ${found.number} is ${found.category} and cannot be cancelled here.`, { status: 409, code: 'NOT_CANCELLABLE' });
    }
    const proposal = store.createProposal({
      type: 'cancel',
      value: {
        invoiceId: found.id, number: found.number, clientName: found.clientName, clientEmail: found.clientEmail,
        amount: found.dueCents / 100, currency: found.currency,
        subject: `Invoice ${found.number} has been cancelled`,
        note: `Invoice ${found.number} for ${formatMoney(found.dueCents, found.currency)} has been cancelled. You do not need to pay it.`,
      },
    });
    store.audit('proposal_created', `Prepared cancellation of ${found.number} (${found.clientName}), waiting for approval`, { proposalId: proposal.id });
    return proposal;
  }

  /* ---------------------------------- tools --------------------------------- */
  // These run on the SERVER on behalf of the AI. None of them can change anything in PayPal.

  function ensureRoom(ctx) {
    if (ctx.proposalIds.length >= MAX_PROPOSALS_PER_CHAT) {
      throw new AppError(`At most ${MAX_PROPOSALS_PER_CHAT} proposals can be prepared in one request. Ask again for the rest.`);
    }
  }

  async function toolPrepareInvoice(args, ctx, today) {
    ensureRoom(ctx);
    const raw = {
      clientName: args.client_name,
      clientEmail: args.client_email,
      currency: args.currency,
      lineItems: (Array.isArray(args.line_items) ? args.line_items : []).map((li) => ({
        description: li?.description,
        quantity: li?.quantity,
        unitPrice: li?.unit_price,
      })),
      dueDate: args.due_date,
      dueInDays: args.due_in_days,
      note: args.note,
    };
    const result = normalizeInvoiceInput(raw, { today, limits: config.limits });
    if (!result.ok) return { error: result.errors.join(' ') };

    const guards = evaluateGuards(result.value, await guardContext());
    const proposal = store.createProposal({
      type: 'invoice',
      value: result.value,
      warnings: guards.warnings,
      blockers: guards.blockers,
      requiresConfirm: guards.requiresConfirm,
    });
    ctx.proposalIds.push(proposal.id);
    const total = formatMoney(result.value.totalCents, result.value.currency);
    store.audit('proposal_created', `Prepared invoice for ${result.value.clientName} (${total}), waiting for approval`, { proposalId: proposal.id });
    return {
      status: 'awaiting_user_approval',
      note: 'NOT sent. The user must review and approve it in the app.',
      client: result.value.clientName,
      total,
      due_date: result.value.dueDate,
      missing: result.value.clientEmail ? [] : ['client_email'],
      warnings: guards.warnings.map((w) => w.message),
      blockers: guards.blockers,
    };
  }

  async function toolListInvoices(args, today) {
    const raw = await loadInvoices();
    let rows = sortInvoices(raw.map((i) => normalizePayPalInvoice(i, today)));
    const status = String(args.status || 'all').toLowerCase();
    if (status === 'unpaid') rows = rows.filter((r) => r.category === 'unpaid' || r.category === 'overdue');
    else if (status !== 'all') rows = rows.filter((r) => r.category === status);
    const q = clean(args.client, 100).toLowerCase();
    if (q) rows = rows.filter((r) => r.clientName.toLowerCase().includes(q) || r.clientEmail.includes(q));

    return {
      total_matching: rows.length,
      showing: Math.min(rows.length, 25),
      invoices: rows.slice(0, 25).map((r) => ({
        id: r.id, number: r.number, client: r.clientName, email: r.clientEmail, status: r.category,
        amount: r.totalCents / 100, amount_due: r.dueCents / 100, currency: r.currency,
        due_date: r.dueDate, days_overdue: r.daysOverdue,
      })),
    };
  }

  async function toolGetInvoice(args, today) {
    const found = await findInvoice(args.invoice_id, today);
    const detail = normalizeInvoiceDetail(await paypal.getInvoice(found.id), today);
    return {
      id: detail.id, number: detail.number, client: detail.clientName, email: detail.clientEmail, status: detail.category,
      currency: detail.currency, amount: detail.totalCents / 100, amount_due: detail.dueCents / 100,
      invoice_date: detail.invoiceDate, due_date: detail.dueDate, days_overdue: detail.daysOverdue,
      items: detail.items.map((i) => ({ description: i.name, quantity: i.quantity, unit_price: i.unitPriceCents / 100 })),
      payments: detail.payments.map((p) => ({ method: p.method, date: p.date, amount: p.amountCents / 100 })),
    };
  }

  async function toolGetSummary(today) {
    const rows = (await loadInvoices()).map((i) => normalizePayPalInvoice(i, today));
    const stats = computeStats(rows);
    return {
      currency: stats.currency,
      outstanding: stats.outstanding,
      overdue_amount: stats.overdueAmount,
      overdue_count: stats.overdueCount,
      collected: stats.collected,
      collection_rate_percent: stats.collectionRate,
      aging: stats.aging,
      top_debtors: computeClients(rows).filter((c) => c.outstanding > 0).slice(0, 5).map((c) => ({ client: c.name, owes: c.outstanding, overdue_invoices: c.overdueCount })),
    };
  }

  async function toolDraftReminder(args, ctx, today) {
    ensureRoom(ctx);
    const found = await findInvoice(args.invoice_id, today).catch((e) => {
      if (e instanceof AppError) throw new AppError(`${e.message} Call list_invoices to get valid ids.`);
      throw e;
    });
    if (!clean(args.message, 1000)) return { error: 'message is required.' };
    const proposal = makeReminderProposal(found, { message: args.message, subject: args.subject, ctx });
    return { status: 'awaiting_user_approval', note: 'NOT sent. The user must approve it in the app.', invoice: found.number, tone: proposal.value.tone };
  }

  async function toolRecordPayment(args, ctx, today) {
    ensureRoom(ctx);
    const found = await findInvoice(args.invoice_id, today);
    const proposal = makePaymentProposal(found, { amount: args.amount, method: args.method, date: args.date, note: args.note }, today, ctx);
    return { status: 'awaiting_user_approval', note: 'NOT recorded yet. The user must approve it in the app.', invoice: found.number, amount: proposal.value.amount };
  }

  function executeTool(name, args, ctx, today) {
    switch (name) {
      case 'prepare_invoice': return toolPrepareInvoice(args, ctx, today);
      case 'list_invoices': return toolListInvoices(args, today);
      case 'get_invoice': return toolGetInvoice(args, today);
      case 'get_summary': return toolGetSummary(today);
      case 'draft_reminder': return toolDraftReminder(args, ctx, today);
      case 'record_payment': return toolRecordPayment(args, ctx, today);
      default: throw new AppError(`Unknown tool "${name}".`);
    }
  }

  /* ----------------------------------- auth --------------------------------- */

  app.get('/api/session', (req, res) => {
    res.json({ authRequired: auth.enabled, authenticated: auth.isAuthenticated(req) });
  });

  app.post('/api/login', loginLimiter, (req, res) => {
    if (!auth.enabled) return res.json({ ok: true, authRequired: false });
    if (!auth.checkPassword(String(req.body?.password ?? ''))) {
      store.audit('login_failed', 'Failed sign-in attempt');
      throw new AppError('That password is not correct.', { status: 401, code: 'BAD_PASSWORD' });
    }
    auth.issue(req, res);
    store.audit('login', 'Signed in');
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    auth.clear(res);
    res.json({ ok: true });
  });

  // Everything below needs a session when APP_PASSWORD is set.
  app.use('/api', (req, res, next) => {
    if (PUBLIC_API.has(`/api${req.path}`) || auth.isAuthenticated(req)) return next();
    return res.status(401).json({ error: 'Please sign in.', code: 'AUTH_REQUIRED' });
  });

  /* --------------------------------- routes --------------------------------- */

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      sandbox,
      version: VERSION,
      model: config.gemini.model,
      paypalConfigured: Boolean(config.paypal.clientId && config.paypal.clientSecret),
      geminiConfigured: Boolean(config.gemini.apiKey),
      limits: {
        highValueThreshold: config.limits.highValueThreshold,
        maxInvoiceAmount: config.limits.maxInvoiceAmount,
        defaultDueDays: config.limits.defaultDueDays,
      },
    });
  });

  app.get('/api/status', async (req, res) => {
    const status = {
      version: VERSION,
      mode: sandbox ? 'sandbox' : 'live',
      uptimeSeconds: Math.round(process.uptime()),
      authRequired: auth.enabled,
      paypal: { configured: Boolean(config.paypal.clientId), connected: null, invoicingPermission: null, error: '' },
      ai: { configured: Boolean(config.gemini.apiKey), models: String(config.gemini.model).split(',').map((m) => m.trim()).filter(Boolean) },
    };
    if (typeof paypal.getToken === 'function') {
      try {
        await paypal.getToken();
        status.paypal.connected = true;
        status.paypal.invoicingPermission = typeof paypal.scope === 'string' ? /\/services\/invoicing/.test(paypal.scope) : null;
      } catch (err) {
        status.paypal.connected = false;
        status.paypal.error = err.message;
      }
    }
    res.json(status);
  });

  app.get('/api/settings', (req, res) => {
    res.json({ limits: { ...config.limits }, defaults });
  });

  app.put('/api/settings', actionLimiter, (req, res) => {
    const result = normalizeSettings(req.body ?? {});
    if (!result.ok) throw new AppError(result.errors.join(' '), { status: 422, code: 'INVALID', details: result.errors });
    Object.assign(config.limits, result.value);
    store.saveSettings(result.value);
    store.audit('settings_changed', `Safety limits updated: max ${result.value.maxInvoiceAmount}, extra confirmation from ${result.value.highValueThreshold}, default due ${result.value.defaultDueDays} days`);
    res.json({ limits: { ...config.limits }, defaults });
  });

  app.get('/api/audit', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    res.json({ entries: store.recentAudit(limit) });
  });

  app.get('/api/proposals', (req, res) => {
    const status = req.query.status === 'all' ? 'all' : 'pending';
    res.json({ proposals: store.listProposals({ status }).map(proposalView) });
  });

  app.get('/api/invoices', async (req, res) => {
    const today = resolveToday(req.query.today);
    const raw = await loadInvoices({ force: req.query.refresh === '1' });
    const rows = sortInvoices(raw.map((i) => normalizePayPalInvoice(i, today)));
    res.json({ today, stats: computeStats(rows), invoices: rows.map(invoiceRow) });
  });

  app.get('/api/clients', async (req, res) => {
    const today = resolveToday(req.query.today);
    const rows = (await loadInvoices()).map((i) => normalizePayPalInvoice(i, today));
    res.json({ clients: computeClients(rows) });
  });

  app.get('/api/invoices/:id', async (req, res) => {
    const today = resolveToday(req.query.today);
    const detail = normalizeInvoiceDetail(await paypal.getInvoice(clean(req.params.id, 100)), today);
    res.json({
      invoice: {
        ...invoiceRow(detail),
        note: detail.note,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        paid: detail.paidCents / 100,
        items: detail.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPriceCents / 100, total: i.totalCents / 100 })),
        payments: detail.payments.map((p) => ({ method: p.method, date: p.date, amount: p.amountCents / 100, note: p.note })),
        clientLink: detail.category === 'draft' ? '' : payerLink(detail.id, ''),
      },
    });
  });

  app.post('/api/invoices/new', actionLimiter, (req, res) => {
    const today = resolveToday(req.body?.today);
    const proposal = store.createProposal({
      type: 'invoice',
      value: {
        clientName: '', clientEmail: '', currency: 'USD',
        lineItems: [{ description: '', quantity: 1, unitPriceCents: 0 }],
        totalCents: 0, dueDate: addDays(today, config.limits.defaultDueDays), note: '',
      },
      warnings: [], blockers: [], requiresConfirm: false,
    });
    res.json({ proposal: proposalView(proposal) });
  });

  app.post('/api/invoices/:id/remind', actionLimiter, async (req, res) => {
    const today = resolveToday(req.body?.today);
    const found = await findInvoice(req.params.id, today);
    res.json({ proposal: proposalView(makeReminderProposal(found, {})) });
  });

  app.post('/api/invoices/:id/payment', actionLimiter, async (req, res) => {
    const today = resolveToday(req.body?.today);
    const found = await findInvoice(req.params.id, today);
    res.json({ proposal: proposalView(makePaymentProposal(found, req.body ?? {}, today)) });
  });

  app.post('/api/invoices/:id/cancel', actionLimiter, async (req, res) => {
    const today = resolveToday(req.body?.today);
    const found = await findInvoice(req.params.id, today);
    res.json({ proposal: proposalView(makeCancelProposal(found)) });
  });

  app.post('/api/chat', chatLimiter, async (req, res) => {
    const body = req.body ?? {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw new AppError('Please type a message.', { status: 400 });
    const trimmed = messages.slice(-12).map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      text: String(m?.text ?? '').slice(0, 4000),
    }));
    if (trimmed[trimmed.length - 1].role !== 'user') throw new AppError('The last message must come from the user.', { status: 400 });

    const today = resolveToday(body.today);
    const { reply, proposalIds, trace } = await runAgent({
      ai,
      messages: trimmed,
      today,
      executeTool: (name, args, ctx) => executeTool(name, args, ctx, today),
    });
    res.json({ reply, trace, proposals: proposalIds.map((id) => proposalView(store.getProposal(id))) });
  });

  function requireProposal(id) {
    const p = store.getProposal(id);
    if (!p) throw new AppError('This proposal has expired or does not exist. Ask the agent to prepare it again.', { status: 404, code: 'NOT_FOUND' });
    return p;
  }

  app.post('/api/proposals/:id/reject', actionLimiter, (req, res) => {
    const p = requireProposal(req.params.id);
    if (p.status === 'done') throw new AppError('This was already approved and sent.', { status: 409, code: 'ALREADY_DONE' });
    if (p.status === 'executing') throw new AppError('This is being processed right now.', { status: 409, code: 'IN_PROGRESS' });
    store.updateProposal(p.id, { status: 'rejected' });
    store.audit('proposal_rejected', `Discarded ${p.type} proposal`, { proposalId: p.id });
    res.json({ proposal: proposalView(store.getProposal(p.id)) });
  });

  app.post('/api/proposals/:id/approve', actionLimiter, async (req, res) => {
    const p = requireProposal(req.params.id);
    const body = req.body ?? {};
    if (p.status === 'done') return res.json({ proposal: proposalView(p) }); // idempotent: double click is harmless
    if (p.status === 'executing') throw new AppError('This is being processed right now.', { status: 409, code: 'IN_PROGRESS' });
    if (p.status === 'rejected') throw new AppError('This proposal was discarded.', { status: 409, code: 'REJECTED' });

    const today = resolveToday(body.today);
    if (p.type === 'invoice') await approveInvoice(p, body, today);
    else if (p.type === 'reminder') await approveReminder(p, body);
    else if (p.type === 'payment') await approvePayment(p, body, today);
    else if (p.type === 'cancel') await approveCancel(p, body);
    else throw new AppError('Unknown proposal type.');
    res.json({ proposal: proposalView(store.getProposal(p.id)) });
  });

  /** Runs `work` while the proposal is locked; on failure it goes back to "pending" so the user can retry. */
  async function execute(p, patch, auditFail, work) {
    store.updateProposal(p.id, { ...patch, status: 'executing', error: null });
    try {
      await work();
    } catch (err) {
      const message = err.userMessage || err.message;
      store.updateProposal(p.id, { status: 'pending', error: message });
      store.audit('action_failed', `${auditFail}: ${err.message}`, { proposalId: p.id });
      if (err instanceof PayPalError && message !== err.message) {
        throw new PayPalError(message, { status: err.status, code: err.code, debugId: err.debugId });
      }
      throw err;
    }
  }

  async function approveInvoice(p, body, today) {
    const edits = body.edits && typeof body.edits === 'object' ? body.edits : {};
    const current = toInvoiceView(p.value);
    const merged = {
      clientName: edits.clientName ?? current.clientName,
      clientEmail: edits.clientEmail ?? current.clientEmail,
      currency: edits.currency ?? current.currency,
      lineItems: Array.isArray(edits.lineItems) ? edits.lineItems : current.lineItems,
      dueDate: edits.dueDate ?? current.dueDate,
      note: edits.note ?? current.note,
    };
    const result = normalizeInvoiceInput(merged, { today, limits: config.limits, requireEmail: true });
    if (!result.ok) throw new AppError(result.errors.join(' '), { status: 422, code: 'INVALID', details: result.errors });

    const guards = evaluateGuards(result.value, await guardContext());
    if (guards.blockers.length) throw new AppError(guards.blockers.join(' '), { status: 422, code: 'BLOCKED' });
    if (guards.requiresConfirm && body.confirmHighValue !== true) {
      throw new AppError(`This is a high-value invoice (${formatMoney(result.value.totalCents, result.value.currency)}). Tick the confirmation box to continue.`, {
        status: 422,
        code: 'CONFIRM_REQUIRED',
      });
    }

    const total = formatMoney(result.value.totalCents, result.value.currency);
    await execute(p, { value: result.value, warnings: guards.warnings }, `Invoice for ${result.value.clientName} failed`, async () => {
      let invoiceId = p.result?.invoiceId;
      try {
        if (!invoiceId) {
          const created = await paypal.createDraftInvoice(buildPayPalInvoice(result.value, { invoicerEmail: config.paypal.invoicerEmail }), p.id);
          invoiceId = created.id;
          store.updateProposal(p.id, { result: { invoiceId } });
          store.audit('invoice_draft_created', `Created draft invoice ${invoiceId} for ${result.value.clientName}`, { proposalId: p.id, invoiceId });
        }
        const sent = await paypal.sendInvoice(invoiceId);
        store.updateProposal(p.id, { status: 'done', result: { invoiceId, link: payerLink(invoiceId, sent.href) }, error: null });
        store.audit('invoice_sent', `Sent invoice ${invoiceId} to ${result.value.clientName} <${result.value.clientEmail}> for ${total}`, {
          proposalId: p.id, invoiceId, email: result.value.clientEmail, totalCents: result.value.totalCents,
        });
        invalidateInvoices();
      } catch (err) {
        if (store.getProposal(p.id)?.result?.invoiceId) {
          err.userMessage = `${err.message} The draft invoice was created in PayPal but not sent. Press approve again to retry sending.`;
        }
        throw err;
      }
    });
  }

  async function approveReminder(p, body) {
    const edits = body.edits && typeof body.edits === 'object' ? body.edits : {};
    const subject = clean(edits.subject ?? p.value.subject, 200);
    const message = clean(edits.message ?? p.value.message, 1000);
    if (!subject) throw new AppError('The reminder needs a subject.', { status: 422, code: 'INVALID' });
    if (!message) throw new AppError('The reminder needs a message.', { status: 422, code: 'INVALID' });

    await execute(p, { value: { ...p.value, subject, message } }, `Reminder for ${p.value.number} failed`, async () => {
      await paypal.remindInvoice(p.value.invoiceId, { subject, note: message });
      store.updateProposal(p.id, { status: 'done', result: { invoiceId: p.value.invoiceId } });
      store.audit('reminder_sent', `Sent ${p.value.tone} reminder for ${p.value.number} to ${p.value.clientName}`, { proposalId: p.id, invoiceId: p.value.invoiceId });
    });
  }

  async function approvePayment(p, body, today) {
    const edits = body.edits && typeof body.edits === 'object' ? body.edits : {};
    const found = await findInvoice(p.value.invoiceId, today);
    if (found.category !== 'unpaid' && found.category !== 'overdue') {
      throw new AppError(`Invoice ${found.number} is now ${found.category}, so no payment can be recorded.`, { status: 409, code: 'NOT_PAYABLE' });
    }
    const result = normalizePaymentInput(
      { method: edits.method ?? p.value.method, date: edits.date ?? p.value.date, amount: edits.amount ?? p.value.amount, note: edits.note ?? p.value.note },
      { today, dueCents: found.dueCents }
    );
    if (!result.ok) throw new AppError(result.errors.join(' '), { status: 422, code: 'INVALID', details: result.errors });
    const v = result.value;
    const text = formatMoney(v.amountCents, found.currency);

    await execute(p, { value: { ...p.value, method: v.method, date: v.date, amount: v.amountCents / 100, note: v.note, dueAmount: found.dueCents / 100 } }, `Payment record for ${found.number} failed`, async () => {
      await paypal.recordPayment(found.id, { method: v.method, date: v.date, amount: (v.amountCents / 100).toFixed(2), currency: found.currency, note: v.note });
      store.updateProposal(p.id, { status: 'done', result: { invoiceId: found.id } });
      store.audit('payment_recorded', `Recorded ${text} (${v.method.toLowerCase().replace('_', ' ')}) for ${found.number} from ${found.clientName}`, { proposalId: p.id, invoiceId: found.id });
      invalidateInvoices();
    });
  }

  async function approveCancel(p, body) {
    const edits = body.edits && typeof body.edits === 'object' ? body.edits : {};
    const subject = clean(edits.subject ?? p.value.subject, 200);
    const note = clean(edits.note ?? p.value.note, 1000);
    if (!subject) throw new AppError('The notice needs a subject.', { status: 422, code: 'INVALID' });

    await execute(p, { value: { ...p.value, subject, note } }, `Cancelling ${p.value.number} failed`, async () => {
      await paypal.cancelInvoice(p.value.invoiceId, { subject, note });
      store.updateProposal(p.id, { status: 'done', result: { invoiceId: p.value.invoiceId } });
      store.audit('invoice_cancelled', `Cancelled invoice ${p.value.number} for ${p.value.clientName}`, { proposalId: p.id, invoiceId: p.value.invoiceId });
      invalidateInvoices();
    });
  }

  /* ---------------------------- static files + errors ----------------------- */

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));
  // Pages like /invoices or /settings are handled by the front-end router.
  app.use((req, res, next) => {
    if (req.method === 'GET' && !path.extname(req.path)) return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    return next();
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    if (err instanceof PayPalError) {
      const status = err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 && err.status !== 429 ? 422 : err.status === 429 ? 429 : 502;
      return res.status(status).json({ error: err.message, code: err.code, debugId: err.debugId || undefined });
    }
    if (err instanceof AiError) return res.status(err.status === 429 ? 429 : 503).json({ error: err.message, code: err.code });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body was not valid JSON.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That message is too large.' });
    console.error('[server] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}