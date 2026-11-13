// Shared UI toolkit: DOM helper, API client, formatting, and the approval cards.
// Security note: all text from the AI / PayPal is inserted with textContent (never innerHTML).

export const state = {
  session: { authRequired: false, authenticated: true },
  limits: { highValueThreshold: 1000, maxInvoiceAmount: 5000, defaultDueDays: 14 },
  pendingPrompt: '',
};

/* ------------------------------- DOM helper -------------------------------- */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8',
  plus: 'M12 5v14M5 12h14',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.file);
  svg.append(path);
  return svg;
}

/* ------------------------------- formatting -------------------------------- */

export function money(n, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n || 0);
  } catch {
    return `${currency || ''} ${Number(n || 0).toFixed(2)}`;
  }
}

const pad = (n) => String(n).padStart(2, '0');
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: String(iso).length === 10 ? 'UTC' : undefined });
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${fmtDate(d.toISOString())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function pill(status, text) {
  return h('span', { class: `pill ${status}`, text: text || status });
}

export function statusPill(inv) {
  return pill(inv.status, inv.status === 'overdue' ? `${inv.daysOverdue}d overdue` : inv.status);
}

/* ---------------------------------- API ------------------------------------ */

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    if (data.code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('fc:auth-required'));
    throw err;
  }
  return data;
}

export const changed = () => window.dispatchEvent(new Event('fc:changed'));

/* -------------------------------- small blocks ----------------------------- */

export function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div', { class: `toast ${kind}`, role: 'status', text: message });
  box.append(el);
  setTimeout(() => el.remove(), 4500);
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty-state' }, h('h3', { text: title }), h('p', { text }), action || null);
}

export function loading(text = 'Loading…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

export function errorBox(message, onRetry) {
  return h('div', { class: 'notice bad' }, h('span', { text: message }), onRetry ? h('button', { type: 'button', class: 'btn ghost small', text: 'Retry', onclick: onRetry }) : null);
}

export function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h2', { text: title }), subtitle ? h('p', { class: 'muted', text: subtitle }) : null), h('div', { class: 'actions' }, actions));
}

/* ============================== approval cards ============================== */
// One card per kind of proposal. Every card ends in an explicit human decision.

function shell(p, title, pillText, pillClass, ...body) {
  return h('article', { class: 'card', 'data-proposal': p.id }, h('div', { class: 'card-head' }, h('h3', { text: title }), h('span', { class: `pill ${pillClass || ''}`, text: pillText })), h('div', { class: 'card-body' }, body));
}

function field(id, label, input) {
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), input);
}

function warnings(p) {
  return h('div', {}, (p.blockers || []).map((b) => h('div', { class: 'notice bad', text: b })), (p.warnings || []).map((w) => h('div', { class: 'notice warn', text: w.message })));
}

/** Wires an approve button: disables while working, shows errors, restores on failure. */
function wireApprove(btn, others, errorEl, label, run) {
  btn.addEventListener('click', async () => {
    errorEl.hidden = true;
    const all = [btn, ...others];
    all.forEach((b) => { b.disabled = true; });
    btn.textContent = 'Working…';
    try {
      await run();
    } catch (err) {
      all.forEach((b) => { b.disabled = false; });
      btn.textContent = label;
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      errorEl.dataset.code = err.code || '';
      errorEl.dispatchEvent(new CustomEvent('fc:error', { detail: err }));
    }
  });
}

function wireDiscard(btn, card, p, text, opts) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await api(`/api/proposals/${p.id}/reject`, { method: 'POST', body: {} }); } catch { /* already gone is fine */ }
    card.replaceWith(h('div', { class: 'msg assistant', text }));
    changed();
    opts.onDiscard?.();
  });
}

export function proposalCard(p, opts = {}) {
  if (p.type === 'invoice') return invoiceCard(p, opts);
  if (p.type === 'reminder') return reminderCard(p, opts);
  if (p.type === 'payment') return paymentCard(p, opts);
  if (p.type === 'cancel') return cancelCard(p, opts);
  return h('div', { class: 'notice bad', text: 'Unknown proposal type.' });
}

function invoiceCard(p, opts) {
  const inv = p.invoice;
  const name = h('input', { id: `n-${p.id}`, value: inv.clientName, maxlength: '100', placeholder: 'Client name' });
  const email = h('input', { id: `e-${p.id}`, type: 'email', value: inv.clientEmail, maxlength: '254', placeholder: 'client@example.com' });
  const currency = h('select', { id: `c-${p.id}` }, ['USD', 'EUR', 'GBP', 'AUD', 'CAD'].map((c) => h('option', { value: c, text: c })));
  currency.value = inv.currency;
  const due = h('input', { id: `d-${p.id}`, type: 'date', value: inv.dueDate });
  const note = h('textarea', { id: `o-${p.id}`, rows: '2', maxlength: '1000', placeholder: 'Optional note to the client' });
  note.value = inv.note || '';

  const itemsBox = h('div', { class: 'items' });
  const totalEl = h('span', { class: 'amount' });
  const error = h('div', { class: 'notice bad', hidden: true });
  const confirmBox = h('input', { type: 'checkbox', id: `k-${p.id}` });
  const confirmRow = h('label', { class: 'confirm', for: `k-${p.id}`, hidden: true }, confirmBox, h('span', { text: 'I have checked the amount and the client, and I want to send this high-value invoice.' }));

  const readItems = () => [...itemsBox.querySelectorAll('.item-row.data')].map((r) => {
    const f = r.querySelectorAll('input');
    return { description: f[0].value, quantity: Number(f[1].value), unitPrice: Number(f[2].value) };
  });
  const recalc = () => {
    const total = readItems().reduce((s, i) => s + (i.quantity || 0) * (i.unitPrice || 0), 0);
    totalEl.textContent = money(total, currency.value);
    confirmRow.hidden = !(total >= state.limits.highValueThreshold) && !p.requiresConfirm;
  };
  const rowFor = (item) => {
    const d = h('input', { value: item.description, maxlength: '200', 'aria-label': 'Description', placeholder: 'Description' });
    const q = h('input', { type: 'number', min: '0', step: 'any', value: String(item.quantity), 'aria-label': 'Quantity' });
    const u = h('input', { type: 'number', min: '0', step: '0.01', value: String(item.unitPrice), 'aria-label': 'Unit price' });
    const rm = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove line', text: '×', onclick: () => { if (itemsBox.querySelectorAll('.item-row.data').length > 1) { row.remove(); recalc(); } } });
    const row = h('div', { class: 'item-row data' }, d, q, u, rm);
    [d, q, u].forEach((x) => x.addEventListener('input', recalc));
    return row;
  };
  itemsBox.append(h('div', { class: 'item-row head' }, h('span', { text: 'Description' }), h('span', { text: 'Qty' }), h('span', { text: 'Price' }), h('span')));
  inv.lineItems.forEach((li) => itemsBox.append(rowFor(li)));

  const addBtn = h('button', { type: 'button', class: 'btn ghost small', text: '+ Add line', onclick: () => { itemsBox.append(rowFor({ description: '', quantity: 1, unitPrice: 0 })); recalc(); } });
  const approve = h('button', { type: 'button', class: 'btn primary', text: 'Approve & send invoice' });
  const discard = h('button', { type: 'button', class: 'btn ghost', text: 'Discard' });

  const card = shell(p, opts.title || 'Invoice ready for your approval', 'Not sent yet', '',
    warnings(p),
    h('div', { class: 'grid2' }, field(`n-${p.id}`, 'Client', name), field(`e-${p.id}`, 'Client email (required to send)', email)),
    h('div', { class: 'grid2' }, field(`d-${p.id}`, 'Due date', due), field(`c-${p.id}`, 'Currency', currency)),
    h('div', {}, h('div', { class: 'label', text: 'Line items' }), itemsBox, h('div', {}, addBtn)),
    field(`o-${p.id}`, 'Note (optional)', note),
    h('div', { class: 'total' }, h('span', { text: 'Total' }), totalEl),
    confirmRow, error,
    h('div', { class: 'actions' }, approve, discard));

  currency.addEventListener('change', recalc);
  recalc();
  if (!inv.clientEmail) email.setAttribute('aria-invalid', 'true');
  email.addEventListener('input', () => email.removeAttribute('aria-invalid'));

  wireApprove(approve, [discard], error, 'Approve & send invoice', async () => {
    if (!email.value.trim()) { email.setAttribute('aria-invalid', 'true'); email.focus(); throw new Error('Please add the client’s email address first.'); }
    try {
      const data = await api(`/api/proposals/${p.id}/approve`, {
        method: 'POST',
        body: { today: todayIso(), confirmHighValue: confirmBox.checked, edits: { clientName: name.value, clientEmail: email.value, currency: currency.value, dueDate: due.value, note: note.value, lineItems: readItems() } },
      });
      card.replaceWith(invoiceDone(data.proposal));
      changed();
      opts.onDone?.(data.proposal);
    } catch (err) {
      if (err.code === 'CONFIRM_REQUIRED') confirmRow.hidden = false;
      throw err;
    }
  });
  wireDiscard(discard, card, p, 'Invoice discarded. Nothing was sent.', opts);
  return card;
}

function invoiceDone(p) {
  const inv = p.invoice;
  const link = p.result && /^https:\/\//.test(p.result.link || '') ? p.result.link : '';
  return shell(p, 'Invoice sent', 'Sent via PayPal', 'paid',
    h('dl', { class: 'kv' },
      h('dt', { text: 'Client' }), h('dd', { text: `${inv.clientName} <${inv.clientEmail}>` }),
      h('dt', { text: 'Total' }), h('dd', { text: money(inv.total, inv.currency) }),
      h('dt', { text: 'Due' }), h('dd', { text: fmtDate(inv.dueDate) }),
      h('dt', { text: 'PayPal ID' }), h('dd', { text: p.result?.invoiceId || '' })),
    h('div', { class: 'actions' },
      link ? h('a', { class: 'link', href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Open the invoice as your client sees it →' }) : null,
      p.result?.invoiceId ? h('a', { class: 'link', href: `/invoices/${encodeURIComponent(p.result.invoiceId)}`, 'data-link': true, text: 'View in Freelance CFO' }) : null));
}

function reminderCard(p, opts) {
  const r = p.reminder;
  const subject = h('input', { id: `s-${p.id}`, value: r.subject, maxlength: '200' });
  const message = h('textarea', { id: `m-${p.id}`, rows: '5', maxlength: '1000' });
  message.value = r.message;
  const error = h('div', { class: 'notice bad', hidden: true });
  const approve = h('button', { type: 'button', class: 'btn primary', text: 'Approve & send reminder' });
  const discard = h('button', { type: 'button', class: 'btn ghost', text: 'Discard' });
  const tone = r.tone === 'friendly' ? 'Friendly' : r.tone === 'firm' ? 'Firm' : 'Final notice';

  const card = shell(p, 'Reminder ready for your approval', `${tone} tone`, r.tone === 'final' ? 'overdue' : r.tone === 'firm' ? 'unpaid' : '',
    h('dl', { class: 'kv' },
      h('dt', { text: 'Invoice' }), h('dd', { text: r.number }),
      h('dt', { text: 'Client' }), h('dd', { text: r.clientName + (r.clientEmail ? ` <${r.clientEmail}>` : '') }),
      h('dt', { text: 'Amount due' }), h('dd', { text: money(r.amount, r.currency) }),
      h('dt', { text: 'Due date' }), h('dd', { text: fmtDate(r.dueDate) + (r.daysOverdue > 0 ? ` (${r.daysOverdue} days overdue)` : '') })),
    field(`s-${p.id}`, 'Subject', subject), field(`m-${p.id}`, 'Message', message), error,
    h('div', { class: 'actions' }, approve, discard));

  wireApprove(approve, [discard], error, 'Approve & send reminder', async () => {
    const data = await api(`/api/proposals/${p.id}/approve`, { method: 'POST', body: { edits: { subject: subject.value, message: message.value } } });
    card.replaceWith(shell(p, 'Reminder sent', 'Sent via PayPal', 'paid', h('p', { text: `Reminder for ${r.number} was sent to ${r.clientName}.` })));
    changed();
    opts.onDone?.(data.proposal);
  });
  wireDiscard(discard, card, p, 'Reminder discarded. Nothing was sent.', opts);
  return card;
}

function paymentCard(p, opts) {
  const v = p.payment;
  const amount = h('input', { id: `a-${p.id}`, type: 'number', min: '0', step: '0.01', value: String(v.amount) });
  const method = h('select', { id: `pm-${p.id}` }, ['BANK_TRANSFER', 'WIRE_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'DEBIT_CARD', 'PAYPAL', 'OTHER'].map((m) => h('option', { value: m, text: m.replace('_', ' ').toLowerCase() })));
  method.value = v.method;
  const date = h('input', { id: `pd-${p.id}`, type: 'date', value: v.date });
  const note = h('input', { id: `pn-${p.id}`, value: v.note || '', maxlength: '500', placeholder: 'Optional note' });
  const error = h('div', { class: 'notice bad', hidden: true });
  const approve = h('button', { type: 'button', class: 'btn primary', text: 'Approve & record payment' });
  const discard = h('button', { type: 'button', class: 'btn ghost', text: 'Discard' });

  const card = shell(p, 'Payment record ready for your approval', 'Not recorded yet', '',
    h('dl', { class: 'kv' },
      h('dt', { text: 'Invoice' }), h('dd', { text: v.number }),
      h('dt', { text: 'Client' }), h('dd', { text: v.clientName }),
      h('dt', { text: 'Still due' }), h('dd', { text: money(v.dueAmount, v.currency) })),
    h('div', { class: 'grid2' }, field(`a-${p.id}`, `Amount received (${v.currency})`, amount), field(`pm-${p.id}`, 'Paid by', method)),
    h('div', { class: 'grid2' }, field(`pd-${p.id}`, 'Date received', date), field(`pn-${p.id}`, 'Note', note)),
    error,
    h('div', { class: 'actions' }, approve, discard));

  wireApprove(approve, [discard], error, 'Approve & record payment', async () => {
    const data = await api(`/api/proposals/${p.id}/approve`, { method: 'POST', body: { today: todayIso(), edits: { amount: amount.value, method: method.value, date: date.value, note: note.value } } });
    card.replaceWith(shell(p, 'Payment recorded', 'Recorded in PayPal', 'paid', h('p', { text: `${money(Number(amount.value), v.currency)} recorded against invoice ${v.number}.` })));
    changed();
    opts.onDone?.(data.proposal);
  });
  wireDiscard(discard, card, p, 'Payment record discarded. Nothing was changed.', opts);
  return card;
}

function cancelCard(p, opts) {
  const v = p.cancel;
  const subject = h('input', { id: `cs-${p.id}`, value: v.subject, maxlength: '200' });
  const note = h('textarea', { id: `cn-${p.id}`, rows: '3', maxlength: '1000' });
  note.value = v.note;
  const error = h('div', { class: 'notice bad', hidden: true });
  const approve = h('button', { type: 'button', class: 'btn danger', text: 'Approve & cancel invoice' });
  const discard = h('button', { type: 'button', class: 'btn ghost', text: 'Keep the invoice' });

  const card = shell(p, 'Cancellation ready for your approval', 'Not cancelled yet', 'overdue',
    h('div', { class: 'notice warn', text: `This cancels invoice ${v.number} for ${money(v.amount, v.currency)} and emails ${v.clientName}. It cannot be undone.` }),
    field(`cs-${p.id}`, 'Subject of the notice', subject), field(`cn-${p.id}`, 'Message to the client', note), error,
    h('div', { class: 'actions' }, approve, discard));

  wireApprove(approve, [discard], error, 'Approve & cancel invoice', async () => {
    const data = await api(`/api/proposals/${p.id}/approve`, { method: 'POST', body: { edits: { subject: subject.value, note: note.value } } });
    card.replaceWith(shell(p, 'Invoice cancelled', 'Cancelled', 'cancelled', h('p', { text: `Invoice ${v.number} was cancelled and ${v.clientName} was notified.` })));
    changed();
    opts.onDone?.(data.proposal);
  });
  wireDiscard(discard, card, p, 'Okay, the invoice was kept.', opts);
  return card;
}