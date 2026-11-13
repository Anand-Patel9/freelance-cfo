// Pure business logic for invoices. No network calls here, which keeps it easy to test.
// Money is handled in integer cents internally so totals never drift (0.1 + 0.2 problems).

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD'];

const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------ small helpers ------------------------------ */

export function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function toCents(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const n = typeof value === 'string' ? Number(value.replace(/[,$€£\s]/g, '')) : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

const toCentsSafe = (value) => {
  const c = toCents(value);
  return Number.isFinite(c) ? c : 0;
};

export const centsToValue = (cents) => (cents / 100).toFixed(2);

export function formatMoney(cents, currency = 'USD') {
  const n = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  return `${currency} ${n}`;
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (positive when `toIso` is later). */
export function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

const roundQty = (q) => Math.round(q * 1000) / 1000;

/* --------------------------- input normalisation --------------------------- */

/**
 * Validate and normalise an invoice request (from the AI tool call or from the
 * approval form). Returns { ok, errors, value }.
 */
export function normalizeInvoiceInput(raw, { today, limits, requireEmail = false }) {
  const errors = [];

  const clientName = clean(raw?.clientName, 100);
  if (!clientName) errors.push('Client name is required.');

  const clientEmail = clean(raw?.clientEmail, 254).toLowerCase();
  if (clientEmail && !EMAIL_RE.test(clientEmail)) errors.push('Client email looks invalid.');
  if (!clientEmail && requireEmail) errors.push('Client email is required before the invoice can be sent.');

  const currency = clean(raw?.currency, 3).toUpperCase() || 'USD';
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    errors.push(`Currency ${currency} is not supported (use ${SUPPORTED_CURRENCIES.join(', ')}).`);
  }

  const rawItems = Array.isArray(raw?.lineItems) ? raw.lineItems : [];
  if (!rawItems.length) errors.push('At least one line item is required.');
  if (rawItems.length > 20) errors.push('Too many line items (maximum 20).');

  const lineItems = [];
  rawItems.slice(0, 20).forEach((item, i) => {
    const label = `Line ${i + 1}`;
    const description = clean(item?.description, 200);
    const hasQty = item?.quantity !== undefined && item?.quantity !== null && item?.quantity !== '';
    const quantity = hasQty ? Number(item.quantity) : 1;
    const unitPriceCents = toCents(item?.unitPrice);
    if (!description) errors.push(`${label}: description is required.`);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) errors.push(`${label}: quantity must be greater than 0.`);
    if (!Number.isFinite(unitPriceCents) || unitPriceCents <= 0) errors.push(`${label}: price must be greater than 0.`);
    lineItems.push({ description, quantity: roundQty(quantity), unitPriceCents });
  });

  let dueDate = '';
  if (raw?.dueDate) {
    if (!isIsoDate(raw.dueDate)) errors.push('Due date must be a valid date (YYYY-MM-DD).');
    else dueDate = raw.dueDate;
  } else {
    const hasDays = raw?.dueInDays !== undefined && raw?.dueInDays !== null && raw?.dueInDays !== '';
    const days = hasDays ? Number(raw.dueInDays) : limits.defaultDueDays;
    if (!Number.isInteger(days) || days < 0 || days > 365) errors.push('Due in days must be a whole number between 0 and 365.');
    else dueDate = addDays(today, days);
  }
  if (dueDate && dueDate < today) errors.push('Due date cannot be in the past.');

  const note = clean(raw?.note, 1000);

  const totalCents = lineItems.reduce((sum, li) => {
    const line = Math.round(li.quantity * li.unitPriceCents);
    return sum + (Number.isFinite(line) ? line : 0);
  }, 0);
  if (!errors.length && totalCents <= 0) errors.push('Invoice total must be greater than 0.');

  return {
    ok: errors.length === 0,
    errors,
    value: { clientName, clientEmail, currency, lineItems, totalCents, dueDate, note },
  };
}

/** Shape used by the browser: dollars, not cents. */
export function toInvoiceView(value) {
  return {
    clientName: value.clientName,
    clientEmail: value.clientEmail,
    currency: value.currency,
    lineItems: value.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPriceCents / 100,
    })),
    total: value.totalCents / 100,
    dueDate: value.dueDate,
    note: value.note,
  };
}

/* ------------------------------- PayPal body ------------------------------- */

export function buildPayPalInvoice(value, { invoicerEmail = '' } = {}) {
  const words = value.clientName.split(' ').filter(Boolean);
  const nameFields =
    words.length >= 2
      ? { name: { given_name: words[0], surname: words.slice(1).join(' ') } }
      : { business_name: value.clientName };

  const detail = {
    currency_code: value.currency,
    payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: value.dueDate },
  };
  if (value.invoiceDate) detail.invoice_date = value.invoiceDate; // only set by the demo seed script
  if (value.note) detail.note = value.note;

  const body = {
    detail,
    primary_recipients: [{ billing_info: { ...nameFields, email_address: value.clientEmail } }],
    items: value.lineItems.map((li) => ({
      name: li.description,
      quantity: String(li.quantity),
      unit_amount: { currency_code: value.currency, value: centsToValue(li.unitPriceCents) },
    })),
    configuration: { allow_tip: false, tax_inclusive: false },
  };
  if (invoicerEmail) body.invoicer = { email_address: invoicerEmail };
  return body;
}

/* --------------------------------- guards ---------------------------------- */

/**
 * Safety rules enforced on the SERVER at approval time (the AI can never bypass them):
 *  - hard cap on invoice size
 *  - extra confirmation for high-value invoices
 *  - warnings for first-time clients and probable duplicates
 */
export function evaluateGuards(value, { limits, knownEmails = null, recentSent = [], now = Date.now() }) {
  const blockers = [];
  const warnings = [];
  const flags = { highValue: false, newClient: false, duplicate: false };
  const total = value.totalCents / 100;
  const shown = formatMoney(value.totalCents, value.currency);

  if (total > limits.maxInvoiceAmount) {
    blockers.push(`Invoice total ${shown} is above the safety limit of ${limits.maxInvoiceAmount}. Raise MAX_INVOICE_AMOUNT if this is intended.`);
  }
  if (total >= limits.highValueThreshold) {
    flags.highValue = true;
    warnings.push({ code: 'HIGH_VALUE', message: `High-value invoice (${shown}). Extra confirmation is required.` });
  }
  if (value.clientEmail && knownEmails && !knownEmails.has(value.clientEmail)) {
    flags.newClient = true;
    warnings.push({ code: 'NEW_CLIENT', message: 'First invoice to this email address. Double-check it is correct.' });
  }
  const dayAgo = now - DAY_MS;
  if (
    value.clientEmail &&
    recentSent.some((e) => e.email === value.clientEmail && e.totalCents === value.totalCents && e.ts > dayAgo)
  ) {
    flags.duplicate = true;
    warnings.push({ code: 'DUPLICATE', message: 'An invoice with the same client and amount was sent in the last 24 hours.' });
  }
  return { blockers, warnings, flags, requiresConfirm: flags.highValue };
}

/* --------------------------- reading PayPal data --------------------------- */

const PAID = new Set(['PAID', 'MARKED_AS_PAID']);
const REFUNDED = new Set(['REFUNDED', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED']);
const OPEN = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING']);

export function categorize(status, dueDate, today) {
  const s = String(status || '').toUpperCase();
  if (PAID.has(s)) return 'paid';
  if (s === 'CANCELLED') return 'cancelled';
  if (REFUNDED.has(s)) return 'refunded';
  if (s === 'DRAFT') return 'draft';
  if (s === 'SCHEDULED') return 'scheduled';
  if (OPEN.has(s)) return dueDate && dueDate < today ? 'overdue' : 'unpaid';
  return 'other';
}

/** Flatten a PayPal invoice object into what the UI and the AI need. */
export function normalizePayPalInvoice(inv, today) {
  const billing = inv?.primary_recipients?.[0]?.billing_info || {};
  const name = billing.name || {};
  const clientName =
    (name.full_name || [name.given_name, name.surname].filter(Boolean).join(' ') || billing.business_name || '').trim() ||
    'Unknown client';
  const currency = inv?.amount?.currency_code || inv?.detail?.currency_code || 'USD';
  const dueDate = inv?.detail?.payment_term?.due_date || '';
  const status = String(inv?.status || '').toUpperCase();
  const category = categorize(status, dueDate, today);

  const itemsTotal = Array.isArray(inv?.items)
    ? inv.items.reduce((s, it) => s + Math.round(toCentsSafe(it?.unit_amount?.value) * Number(it?.quantity || 1)), 0)
    : 0;
  const totalCents = inv?.amount?.value != null ? toCentsSafe(inv.amount.value) : itemsTotal;
  const closed = category === 'paid' || category === 'cancelled' || category === 'refunded';
  const dueCents = inv?.due_amount?.value != null ? toCentsSafe(inv.due_amount.value) : closed ? 0 : totalCents;

  return {
    id: inv?.id || '',
    number: inv?.detail?.invoice_number || inv?.id || '',
    clientName,
    clientEmail: String(billing.email_address || '').toLowerCase(),
    status,
    category,
    currency,
    totalCents,
    dueCents,
    dueDate,
    invoiceDate: inv?.detail?.invoice_date || '',
    paidCents: category === 'draft' || category === 'cancelled' || category === 'scheduled' ? 0 : Math.max(0, totalCents - dueCents),
    daysOverdue: category === 'overdue' && dueDate ? daysBetween(dueDate, today) : 0,
  };
}

const ORDER = { overdue: 0, unpaid: 1, draft: 2, scheduled: 3, paid: 4, refunded: 5, cancelled: 6, other: 7 };

export function sortInvoices(list) {
  return [...list].sort(
    (a, b) =>
      (ORDER[a.category] ?? 9) - (ORDER[b.category] ?? 9) ||
      (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31')
  );
}

/** Dashboard numbers for the most common currency (others are counted, not mixed in). */
export function computeStats(invoices) {
  const counts = {};
  for (const i of invoices) counts[i.currency] = (counts[i.currency] || 0) + 1;
  const currency = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
  const mine = invoices.filter((i) => i.currency === currency);

  const sum = (rows, key) => rows.reduce((s, i) => s + i[key], 0) / 100;
  const overdue = mine.filter((i) => i.category === 'overdue');
  const unpaid = mine.filter((i) => i.category === 'unpaid');
  const paid = mine.filter((i) => i.category === 'paid');

  const aging = { notDue: 0, d1to7: 0, d8to21: 0, d22plus: 0 };
  for (const i of [...overdue, ...unpaid]) {
    const amount = i.dueCents / 100;
    if (i.category === 'unpaid') aging.notDue += amount;
    else if (i.daysOverdue <= 7) aging.d1to7 += amount;
    else if (i.daysOverdue <= 21) aging.d8to21 += amount;
    else aging.d22plus += amount;
  }
  const outstandingTotal = sum([...overdue, ...unpaid], 'dueCents');
  const collected = sum(mine, 'paidCents');
  const billed = collected + outstandingTotal;

  return {
    currency,
    aging,
    collected,
    collectionRate: billed > 0 ? Math.round((collected / billed) * 100) : null,
    outstanding: outstandingTotal,
    overdueCount: overdue.length,
    overdueAmount: sum(overdue, 'dueCents'),
    unpaidCount: unpaid.length,
    paidCount: paid.length,
    paidAmount: sum(paid, 'totalCents'),
    draftCount: mine.filter((i) => i.category === 'draft').length,
    otherCurrencyInvoices: invoices.length - mine.length,
  };
}

/** How firm a payment reminder should be. */
export function reminderTone(daysOverdue) {
  if (daysOverdue <= 7) return 'friendly';
  if (daysOverdue <= 21) return 'firm';
  return 'final';
}

/* ----------------------- invoice detail, clients, actions ---------------------- */

/** Everything the invoice page needs: the flat summary plus items, payments and timestamps. */
export function normalizeInvoiceDetail(inv, today) {
  const base = normalizePayPalInvoice(inv, today);
  const items = (Array.isArray(inv?.items) ? inv.items : []).map((it) => {
    const unit = toCentsSafe(it?.unit_amount?.value);
    const quantity = Number(it?.quantity || 1);
    return { name: String(it?.name || ''), quantity, unitPriceCents: unit, totalCents: Math.round(unit * quantity) };
  });
  const payments = (Array.isArray(inv?.payments?.transactions) ? inv.payments.transactions : []).map((p) => ({
    method: String(p?.method || ''),
    date: String(p?.payment_date || ''),
    amountCents: toCentsSafe(p?.amount?.value),
    note: String(p?.note || ''),
  }));
  return {
    ...base,
    items,
    payments,
    note: String(inv?.detail?.note || ''),
    createdAt: inv?.detail?.metadata?.create_time || '',
    updatedAt: inv?.detail?.metadata?.last_update_time || '',
  };
}

/** One row per client (and currency) with totals, built from the invoice list. */
export function computeClients(invoices) {
  const map = new Map();
  for (const i of invoices) {
    if (i.category === 'draft' || i.category === 'cancelled') continue;
    const key = `${i.clientEmail || i.clientName.toLowerCase()}|${i.currency}`;
    const c = map.get(key) || {
      name: i.clientName, email: i.clientEmail, currency: i.currency,
      invoiceCount: 0, billedCents: 0, paidCents: 0, outstandingCents: 0, overdueCount: 0, lastInvoiceDate: '',
    };
    c.invoiceCount += 1;
    c.billedCents += i.totalCents;
    c.paidCents += i.paidCents;
    if (i.category === 'unpaid' || i.category === 'overdue') c.outstandingCents += i.dueCents;
    if (i.category === 'overdue') c.overdueCount += 1;
    if (i.invoiceDate && i.invoiceDate > c.lastInvoiceDate) c.lastInvoiceDate = i.invoiceDate;
    map.set(key, c);
  }
  return [...map.values()]
    .map((c) => ({
      name: c.name, email: c.email, currency: c.currency, invoiceCount: c.invoiceCount,
      billed: c.billedCents / 100, paid: c.paidCents / 100, outstanding: c.outstandingCents / 100,
      overdueCount: c.overdueCount, lastInvoiceDate: c.lastInvoiceDate,
    }))
    .sort((a, b) => b.outstanding - a.outstanding || b.billed - a.billed);
}

/** A ready-to-edit reminder message whose tone depends on how late the invoice is. */
export function reminderTemplate({ tone, clientName, number, amountText, dueDate, daysOverdue }) {
  const first = String(clientName || '').split(' ')[0] || 'there';
  if (tone === 'friendly' && daysOverdue <= 0) {
    return `Hi ${first}, a friendly reminder that invoice ${number} for ${amountText} is due on ${dueDate}. If you have already paid, please ignore this note. Thank you!`;
  }
  if (tone === 'friendly') {
    return `Hi ${first}, just a quick note that invoice ${number} for ${amountText} (due ${dueDate}) is now ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue. If it slipped through, you can pay it from the invoice link. Thank you!`;
  }
  if (tone === 'firm') {
    return `Hi ${first}, invoice ${number} for ${amountText} was due on ${dueDate} and is now ${daysOverdue} days overdue. Could you please arrange payment this week, or let me know if there is a problem with the invoice? Thank you.`;
  }
  return `Hi ${first}, this is a final reminder that invoice ${number} for ${amountText} has been overdue since ${dueDate} (${daysOverdue} days). Please pay it as soon as possible or contact me today to agree a plan. Thank you.`;
}

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'WIRE_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'DEBIT_CARD', 'PAYPAL', 'OTHER'];

/** Validates "record an offline payment" input. */
export function normalizePaymentInput(raw, { today, dueCents }) {
  const errors = [];
  const method = clean(raw?.method, 30).toUpperCase() || 'BANK_TRANSFER';
  if (!PAYMENT_METHODS.includes(method)) errors.push(`Payment method must be one of ${PAYMENT_METHODS.join(', ')}.`);
  const date = clean(raw?.date, 10) || today;
  if (!isIsoDate(date)) errors.push('Payment date must be a valid date.');
  else if (date > today) errors.push('Payment date cannot be in the future.');
  const amountCents = raw?.amount === undefined || raw?.amount === '' ? dueCents : toCents(raw.amount);
  if (!Number.isFinite(amountCents) || amountCents <= 0) errors.push('Payment amount must be greater than 0.');
  else if (amountCents > dueCents) errors.push('Payment amount cannot be more than the amount still due.');
  const note = clean(raw?.note, 500);
  return { ok: errors.length === 0, errors, value: { method, date, amountCents, note } };
}

/** Validates the editable safety limits from the settings page. */
export function normalizeSettings(raw) {
  const errors = [];
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  const maxInvoiceAmount = num(raw?.maxInvoiceAmount);
  const highValueThreshold = num(raw?.highValueThreshold);
  const defaultDueDays = num(raw?.defaultDueDays);
  if (!Number.isFinite(maxInvoiceAmount) || maxInvoiceAmount <= 0 || maxInvoiceAmount > 1_000_000) errors.push('Maximum invoice amount must be between 1 and 1,000,000.');
  if (!Number.isFinite(highValueThreshold) || highValueThreshold <= 0) errors.push('High-value threshold must be greater than 0.');
  if (Number.isFinite(maxInvoiceAmount) && Number.isFinite(highValueThreshold) && highValueThreshold > maxInvoiceAmount) {
    errors.push('The high-value threshold cannot be above the maximum invoice amount.');
  }
  if (!Number.isInteger(defaultDueDays) || defaultDueDays < 0 || defaultDueDays > 365) errors.push('Default due days must be a whole number from 0 to 365.');
  return { ok: errors.length === 0, errors, value: { maxInvoiceAmount, highValueThreshold, defaultDueDays } };
}