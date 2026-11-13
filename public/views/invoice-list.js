import { api, h, money, fmtDate, todayIso, statusPill, pageHead, emptyState, errorBox } from '../ui.js';

const TABS = [['all', 'All'], ['unpaid', 'Open'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['draft', 'Drafts']];

export async function render(root, { query, navigate, setActions }) {
  const data = await api(`/api/invoices?today=${todayIso()}&refresh=1`);
  let status = TABS.some((t) => t[0] === query.get('status')) ? query.get('status') : 'all';
  let q = query.get('q') || '';

  setActions(h('a', { class: 'btn primary', href: '/new', 'data-link': true, text: 'New invoice' }));

  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search client, email or number', value: q, 'aria-label': 'Search invoices' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'table-wrap' });

  const matches = (i) => {
    if (status === 'unpaid' && i.status !== 'unpaid' && i.status !== 'overdue') return false;
    if (status !== 'all' && status !== 'unpaid' && i.status !== status) return false;
    const needle = q.trim().toLowerCase();
    return !needle || [i.clientName, i.clientEmail, i.number].some((v) => String(v).toLowerCase().includes(needle));
  };

  function draw() {
    tabs.replaceChildren(...TABS.map(([key, label]) => {
      const count = data.invoices.filter((i) => (key === 'all' ? true : key === 'unpaid' ? i.status === 'unpaid' || i.status === 'overdue' : i.status === key)).length;
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(status === key), class: `tab${status === key ? ' active' : ''}`, onclick: () => { status = key; draw(); } }, label, h('span', { class: 'count', text: String(count) }));
    }));
    const rows = data.invoices.filter(matches);
    if (!rows.length) {
      body.replaceChildren(data.invoices.length ? emptyState('No invoices match', 'Try another filter or search.') : emptyState('No invoices yet', 'Create one by hand or let the assistant do it.', h('a', { class: 'btn primary', href: '/assistant', 'data-link': true, text: 'Open the assistant' })));
      return;
    }
    body.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ['Invoice', 'Client', 'Status', 'Due', 'Amount', 'Still due'].map((c, i) => h('th', { class: i > 2 ? 'num' : '', text: c })))),
      h('tbody', {}, rows.map((i) => h('tr', { class: 'row-link', onclick: () => navigate(`/invoices/${encodeURIComponent(i.id)}`) },
        h('td', {}, h('a', { href: `/invoices/${encodeURIComponent(i.id)}`, 'data-link': true, text: i.number })),
        h('td', {}, h('div', { text: i.clientName }), h('div', { class: 'muted small', text: i.clientEmail })),
        h('td', {}, statusPill(i)),
        h('td', { class: 'num', text: fmtDate(i.dueDate) }),
        h('td', { class: 'num', text: money(i.total, i.currency) }),
        h('td', { class: 'num', text: money(i.due, i.currency) }))))));
  }

  search.addEventListener('input', () => { q = search.value; draw(); });
  root.append(pageHead('Invoices', `${data.invoices.length} invoice${data.invoices.length === 1 ? '' : 's'} in your PayPal sandbox account`), h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, tabs, search), body));
  draw();
}