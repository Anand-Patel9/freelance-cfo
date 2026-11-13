import { api, h, money, fmtDate, fmtTime, todayIso, state, statusPill, pageHead, emptyState } from '../ui.js';

const AUDIT_LABELS = {
  invoice_sent: 'Invoice sent', reminder_sent: 'Reminder sent', payment_recorded: 'Payment recorded', invoice_cancelled: 'Invoice cancelled',
  proposal_created: 'Prepared', proposal_rejected: 'Discarded', action_failed: 'Failed', settings_changed: 'Settings',
};

function kpi(label, value, sub, tone) {
  return h('div', { class: `stat${tone ? ` ${tone}` : ''}` }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), h('div', { class: 'sub', text: sub }));
}

function agingChart(stats) {
  const rows = [
    ['Not due yet', stats.aging.notDue, 'ok'],
    ['1–7 days late', stats.aging.d1to7, 'warn'],
    ['8–21 days late', stats.aging.d8to21, 'warn2'],
    ['Over 21 days', stats.aging.d22plus, 'bad'],
  ];
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return h('div', { class: 'aging' }, rows.map(([label, amount, tone]) => {
    const fill = h('span', { class: `fill ${tone}` });
    fill.style.setProperty('--w', `${Math.max(amount > 0 ? 4 : 0, Math.round((amount / max) * 100))}%`);
    return h('div', { class: 'aging-row' }, h('span', { class: 'aging-label', text: label }), h('div', { class: 'bar' }, fill), h('span', { class: 'aging-amount', text: money(amount, stats.currency) }));
  }));
}

export async function render(root, { navigate, setActions }) {
  const [inv, audit, pending] = await Promise.all([
    api(`/api/invoices?today=${todayIso()}`),
    api('/api/audit?limit=8'),
    api('/api/proposals?status=pending'),
  ]);
  const s = inv.stats;
  const overdue = inv.invoices.filter((i) => i.status === 'overdue').sort((a, b) => b.daysOverdue - a.daysOverdue);

  setActions(
    h('a', { class: 'btn ghost', href: '/new', 'data-link': true, text: 'New invoice' }),
    h('button', { type: 'button', class: 'btn primary', text: 'Run collections review', onclick: () => { state.pendingPrompt = 'Review my collections: draft reminders for my overdue invoices.'; navigate('/assistant'); } }));

  root.append(
    pageHead('Dashboard', `Your invoices and collections at a glance · ${fmtDate(todayIso())}`),
    pending.proposals.length
      ? h('a', { class: 'callout', href: '/approvals', 'data-link': true }, h('strong', { text: `${pending.proposals.length} action${pending.proposals.length === 1 ? '' : 's'} waiting for your approval` }), h('span', { text: 'Review →' }))
      : null,
    h('div', { class: 'stats' },
      kpi('Outstanding', money(s.outstanding, s.currency), `${s.unpaidCount + s.overdueCount} open invoice${s.unpaidCount + s.overdueCount === 1 ? '' : 's'}`),
      kpi('Overdue', money(s.overdueAmount, s.currency), `${s.overdueCount} overdue`, s.overdueCount > 0 ? 'alert' : ''),
      kpi('Collected', money(s.collected, s.currency), s.collectionRate === null ? 'nothing billed yet' : `${s.collectionRate}% of billed`),
      kpi('Drafts', String(s.draftCount), s.otherCurrencyInvoices ? `${s.otherCurrencyInvoices} in other currencies` : 'not yet sent')),
    h('div', { class: 'cols' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Money owed, by how late it is' })), agingChart(s)),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', { text: 'Needs attention' }), h('a', { class: 'link', href: '/invoices?status=overdue', 'data-link': true, text: 'All overdue' })),
        overdue.length
          ? h('ul', { class: 'list' }, overdue.slice(0, 5).map((i) => h('li', {}, h('a', { href: `/invoices/${encodeURIComponent(i.id)}`, 'data-link': true }, h('strong', { text: i.clientName }), h('span', { class: 'muted', text: ` · ${i.number}` })), statusPill(i), h('span', { class: 'num', text: money(i.due, i.currency) }))))
          : emptyState('Nothing is overdue', 'When an invoice passes its due date it shows up here.'))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Recent activity' }), h('a', { class: 'link', href: '/activity', 'data-link': true, text: 'See all' })),
      audit.entries.length
        ? h('ol', { class: 'audit' }, audit.entries.map((e) => h('li', {}, h('time', { text: fmtTime(e.ts) }), h('span', { class: 'tag', text: AUDIT_LABELS[e.type] || e.type }), h('span', { text: e.summary }))))
        : emptyState('No activity yet', 'Ask the assistant to create your first invoice.', h('a', { class: 'btn primary', href: '/assistant', 'data-link': true, text: 'Open the assistant' }))));
}