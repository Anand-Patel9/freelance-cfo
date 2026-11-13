import { api, h, todayIso, proposalCard, pageHead } from '../ui.js';

export async function render(root, { navigate }) {
  const { proposal } = await api('/api/invoices/new', { method: 'POST', body: { today: todayIso() } });
  root.append(
    pageHead('New invoice', 'Fill in the details and approve to send it through PayPal. Prefer to describe it in words? Ask the assistant.', h('a', { class: 'btn ghost', href: '/assistant', 'data-link': true, text: 'Use the assistant' })),
    h('div', { class: 'narrow' }, proposalCard(proposal, { title: 'Invoice details', onDone: (p) => setTimeout(() => navigate(`/invoices/${encodeURIComponent(p.result.invoiceId)}`), 1500) })));
}