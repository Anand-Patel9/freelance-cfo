import { api, h, money, fmtDate, fmtTime, todayIso, statusPill, pageHead, proposalCard, toast, errorBox } from '../ui.js';

export async function render(root, { params, navigate }) {
  const { invoice: inv } = await api(`/api/invoices/${encodeURIComponent(params.id)}?today=${todayIso()}`);
  const open = inv.status === 'unpaid' || inv.status === 'overdue';
  const slot = h('div', { class: 'action-slot' });

  async function start(kind, label) {
    slot.replaceChildren(h('div', { class: 'loading', text: 'Preparing…' }));
    try {
      const { proposal } = await api(`/api/invoices/${encodeURIComponent(inv.id)}/${kind}`, { method: 'POST', body: { today: todayIso() } });
      slot.replaceChildren(proposalCard(proposal, { onDone: () => setTimeout(() => navigate(`/invoices/${encodeURIComponent(inv.id)}`), 1200), onDiscard: () => slot.replaceChildren() }));
      slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      slot.replaceChildren(errorBox(err.message));
    }
  }

  const actions = [
    open ? h('button', { type: 'button', class: 'btn primary', text: 'Send a reminder', onclick: () => start('remind') }) : null,
    open ? h('button', { type: 'button', class: 'btn', text: 'Record a payment', onclick: () => start('payment') }) : null,
    open ? h('button', { type: 'button', class: 'btn ghost danger-text', text: 'Cancel invoice', onclick: () => start('cancel') }) : null,
    inv.clientLink ? h('a', { class: 'btn ghost', href: inv.clientLink, target: '_blank', rel: 'noopener noreferrer', text: 'Open client view ↗' }) : null,
  ];

  root.append(
    h('a', { class: 'link back', href: '/invoices', 'data-link': true, text: '← All invoices' }),
    pageHead(`Invoice ${inv.number}`, `${inv.clientName}${inv.clientEmail ? ` · ${inv.clientEmail}` : ''}`, statusPill(inv)),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'label', text: 'Total' }), h('div', { class: 'value', text: money(inv.total, inv.currency) })),
      h('div', { class: 'stat' }, h('div', { class: 'label', text: 'Paid' }), h('div', { class: 'value', text: money(inv.paid, inv.currency) })),
      h('div', { class: 'stat' }, h('div', { class: 'label', text: 'Still due' }), h('div', { class: 'value', text: money(inv.due, inv.currency) })),
      h('div', { class: 'stat' }, h('div', { class: 'label', text: 'Due date' }), h('div', { class: 'value small-value', text: fmtDate(inv.dueDate) }), h('div', { class: 'sub', text: inv.daysOverdue > 0 ? `${inv.daysOverdue} days overdue` : 'issued ' + fmtDate(inv.invoiceDate) }))),
    actions.some(Boolean) ? h('div', { class: 'actions bar' }, actions) : null,
    slot,
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Items' })),
      inv.items.length
        ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Description', 'Qty', 'Price', 'Total'].map((c, i) => h('th', { class: i ? 'num' : '', text: c })))),
            h('tbody', {}, inv.items.map((i) => h('tr', {}, h('td', { text: i.name }), h('td', { class: 'num', text: String(i.quantity) }), h('td', { class: 'num', text: money(i.unitPrice, inv.currency) }), h('td', { class: 'num', text: money(i.total, inv.currency) }))))))
        : h('p', { class: 'muted', text: 'No line items.' }),
      inv.note ? h('p', { class: 'muted', text: `Note to client: ${inv.note}` }) : null),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Payments' })),
      inv.payments.length
        ? h('ul', { class: 'list' }, inv.payments.map((p) => h('li', {}, h('span', { text: `${fmtDate(p.date)} · ${p.method.replace('_', ' ').toLowerCase()}` }), h('span', { class: 'num', text: money(p.amount, inv.currency) }))))
        : h('p', { class: 'muted', text: 'No payments recorded yet.' })),
    h('p', { class: 'muted small', text: `PayPal ID ${inv.id}${inv.createdAt ? ` · created ${fmtTime(inv.createdAt)}` : ''}${inv.updatedAt ? ` · updated ${fmtTime(inv.updatedAt)}` : ''}` }));
}