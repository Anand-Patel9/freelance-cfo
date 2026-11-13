import { api, h, state, toast, pageHead, pill } from '../ui.js';

function row(label, value, tone) {
  return h('div', { class: 'setting-row' }, h('span', { class: 'muted', text: label }), h('span', {}, typeof value === 'string' ? value : value, tone ? pill(tone[0], tone[1]) : null));
}

export async function render(root) {
  const [status, settings] = await Promise.all([api('/api/status'), api('/api/settings')]);
  const l = settings.limits;

  const max = h('input', { id: 's-max', type: 'number', min: '1', step: '1', value: String(l.maxInvoiceAmount) });
  const high = h('input', { id: 's-high', type: 'number', min: '1', step: '1', value: String(l.highValueThreshold) });
  const days = h('input', { id: 's-days', type: 'number', min: '0', max: '365', step: '1', value: String(l.defaultDueDays) });
  const error = h('div', { class: 'notice bad', hidden: true });
  const save = h('button', { type: 'submit', class: 'btn primary', text: 'Save limits' });

  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); error.hidden = true; save.disabled = true;
    try {
      const res = await api('/api/settings', { method: 'PUT', body: { maxInvoiceAmount: max.value, highValueThreshold: high.value, defaultDueDays: days.value } });
      Object.assign(state.limits, res.limits);
      toast('Safety limits saved.');
    } catch (err) { error.textContent = err.message; error.hidden = false; }
    save.disabled = false;
  } },
  h('div', { class: 'field' }, h('label', { for: 's-max', text: 'Maximum invoice amount (hard stop)' }), max, h('small', { class: 'muted', text: 'The server refuses to create invoices above this amount, whatever the AI or the form says.' })),
  h('div', { class: 'field' }, h('label', { for: 's-high', text: 'Extra confirmation from this amount' }), high, h('small', { class: 'muted', text: 'At or above this amount you must tick a confirmation box before sending.' })),
  h('div', { class: 'field' }, h('label', { for: 's-days', text: 'Default payment terms (days)' }), days, h('small', { class: 'muted', text: 'Used when an invoice has no due date.' })),
  error, h('div', { class: 'actions' }, save));

  const pp = status.paypal;
  root.append(
    pageHead('Settings', 'Connection status and the safety rules that protect your money'),
    h('div', { class: 'cols' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Safety limits' })), form),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'System status' })),
        row('Mode', status.mode === 'sandbox' ? 'PayPal Sandbox (test money only)' : 'LIVE PayPal', status.mode === 'sandbox' ? ['paid', 'safe'] : ['overdue', 'live']),
        row('PayPal connection', pp.connected === null ? 'Not checked' : pp.connected ? 'Connected' : pp.error || 'Not connected', pp.connected ? ['paid', 'ok'] : pp.connected === false ? ['overdue', 'error'] : null),
        row('Invoicing permission', pp.invoicingPermission === null ? 'Unknown' : pp.invoicingPermission ? 'Granted' : 'Missing', pp.invoicingPermission ? ['paid', 'ok'] : pp.invoicingPermission === false ? ['overdue', 'error'] : null),
        row('AI models', status.ai.models.join(' → ')),
        row('Sign-in', status.authRequired ? 'Password protected' : 'Open (local use)'),
        row('Version', status.version),
        h('p', { class: 'muted small', text: 'Models are tried in order. If one is slow or unavailable the next takes over automatically.' }))),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'How the agent is kept safe' })),
      h('ul', { class: 'bullets' },
        h('li', { text: 'The AI can read your PayPal data, but every change (invoice, reminder, payment record) is only a proposal until you approve it.' }),
        h('li', { text: 'The server re-checks every approval, including your edits, so limits cannot be bypassed from the browser or by the AI.' }),
        h('li', { text: 'Retries never create duplicate invoices, and every action is written to the activity log.' }),
        h('li', { text: 'Text from client messages is treated as data, never as instructions to the agent.' }))));
}