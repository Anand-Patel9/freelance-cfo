import { api, h, pageHead, emptyState, proposalCard } from '../ui.js';

export async function render(root) {
  const { proposals } = await api('/api/proposals?status=pending');
  root.append(pageHead('Approvals', 'Everything the agent (or you) prepared that still needs a decision. Nothing here has touched PayPal yet.'));
  if (!proposals.length) {
    root.append(h('section', { class: 'panel' }, emptyState('Nothing waiting', 'When the assistant prepares an invoice, reminder or payment record, it waits here for your approval.', h('a', { class: 'btn primary', href: '/assistant', 'data-link': true, text: 'Ask the assistant' }))));
    return;
  }
  root.append(h('div', { class: 'stack' }, proposals.map((p) => proposalCard(p))));
}