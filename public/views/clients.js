import { api, h, money, fmtDate, todayIso, pageHead, emptyState } from '../ui.js';

export async function render(root, { navigate }) {
  const { clients } = await api(`/api/clients?today=${todayIso()}`);
  root.append(pageHead('Clients', 'Built automatically from your invoices'));
  if (!clients.length) {
    root.append(h('section', { class: 'panel' }, emptyState('No clients yet', 'Clients appear here after you send your first invoice.', h('a', { class: 'btn primary', href: '/new', 'data-link': true, text: 'Create an invoice' }))));
    return;
  }
  root.append(h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Client', 'Invoices', 'Billed', 'Paid', 'Outstanding', 'Last invoice'].map((c, i) => h('th', { class: i ? 'num' : '', text: c })))),
    h('tbody', {}, clients.map((c) => h('tr', { class: 'row-link', onclick: () => navigate(`/invoices?q=${encodeURIComponent(c.email || c.name)}`) },
      h('td', {}, h('div', { text: c.name }), h('div', { class: 'muted small', text: c.email })),
      h('td', { class: 'num', text: String(c.invoiceCount) }),
      h('td', { class: 'num', text: money(c.billed, c.currency) }),
      h('td', { class: 'num', text: money(c.paid, c.currency) }),
      h('td', { class: 'num' }, money(c.outstanding, c.currency), c.overdueCount ? h('span', { class: 'pill overdue inline', text: `${c.overdueCount} overdue` }) : null),
      h('td', { class: 'num', text: fmtDate(c.lastInvoiceDate) })))))))); 
}