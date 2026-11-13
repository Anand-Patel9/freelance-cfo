import { api, h, fmtTime, pageHead, emptyState } from '../ui.js';

const LABELS = {
  invoice_sent: ['Invoice sent', 'paid'], invoice_draft_created: ['Draft created', ''], reminder_sent: ['Reminder sent', 'paid'], payment_recorded: ['Payment recorded', 'paid'],
  invoice_cancelled: ['Cancelled', 'cancelled'], proposal_created: ['Prepared', ''], proposal_rejected: ['Discarded', ''], action_failed: ['Failed', 'overdue'],
  settings_changed: ['Settings', ''], login: ['Sign-in', ''], login_failed: ['Failed sign-in', 'overdue'],
};

export async function render(root) {
  const { entries } = await api('/api/audit?limit=200');
  let filter = 'all';
  const body = h('div', { class: 'table-wrap' });
  const select = h('select', { 'aria-label': 'Filter activity' },
    h('option', { value: 'all', text: 'Everything' }), h('option', { value: 'done', text: 'Things that were sent or changed' }), h('option', { value: 'failed', text: 'Failures' }));
  const matches = (e) => filter === 'all' || (filter === 'failed' ? e.type === 'action_failed' || e.type === 'login_failed' : ['invoice_sent', 'reminder_sent', 'payment_recorded', 'invoice_cancelled'].includes(e.type));

  function draw() {
    const rows = entries.filter(matches);
    body.replaceChildren(rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Event', 'Details'].map((c) => h('th', { text: c })))),
          h('tbody', {}, rows.map((e) => { const [label, cls] = LABELS[e.type] || [e.type, '']; return h('tr', {}, h('td', { class: 'nowrap', text: fmtTime(e.ts) }), h('td', {}, h('span', { class: `pill ${cls}`, text: label })), h('td', { text: e.summary })); })))
      : emptyState('Nothing here', 'Actions the agent and you take are recorded here.'));
  }
  select.addEventListener('change', () => { filter = select.value; draw(); });
  root.append(pageHead('Activity', 'A permanent record of every action, with timestamps. The agent cannot edit it.'), h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, select), body));
  draw();
}