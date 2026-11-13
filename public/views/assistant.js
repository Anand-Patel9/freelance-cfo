import { api, h, state, todayIso, proposalCard } from '../ui.js';

// The conversation lives at module level so it survives moving between pages.
const chat = { history: [], nodes: [] };

const EXAMPLES = [
  { label: 'Invoice from a messy message', text: 'Client message: "Hi! Can you do the logo + 2 social banners? Logo is $250, banners $60 each. Need the invoice by Friday. Mail me at ankit@example.com — Ankit Verma"' },
  { label: 'Quick invoice', text: 'Invoice Priya Sharma 3 pages of copywriting at $50 each plus $100 hosting setup, due in 10 days. Her email is priya@example.com' },
  { label: 'Who hasn’t paid me?', text: 'Who hasn’t paid me yet?' },
  { label: 'How is my cash flow?', text: 'How is my cash flow? Who is my riskiest client?' },
  { label: 'Review my collections', text: 'Review my collections: draft reminders for my overdue invoices.' },
  { label: 'Payment received', text: 'Ravi paid me by bank transfer yesterday for his overdue invoice.' },
];

function traceBlock(trace) {
  if (!trace?.length) return null;
  return h('details', { class: 'trace' },
    h('summary', { text: `What I did (${trace.length} step${trace.length === 1 ? '' : 's'})` }),
    h('ol', {}, trace.map((t) => h('li', { class: t.ok ? '' : 'failed', text: t.summary }))));
}

export function render(root, { navigate }) {
  const log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { id: 'chat-input', rows: '2', maxlength: '4000', placeholder: 'e.g. Invoice Priya Sharma $400 for logo design, due in 10 days. priya@example.com', 'aria-label': 'Message the agent' });
  const sendBtn = h('button', { type: 'submit', class: 'btn primary', text: 'Send' });
  let busy = false;

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const add = (cls, text) => { const el = h('div', { class: `msg ${cls}`, text }); log.append(el); scroll(); return el; };

  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true; sendBtn.textContent = 'Thinking…';
    add('user', text);
    chat.history.push({ role: 'user', text });
    input.value = '';
    const typing = add('assistant typing', 'Working on it…');
    try {
      const data = await api('/api/chat', { method: 'POST', body: { messages: chat.history.slice(-12), today: todayIso() } });
      typing.remove();
      chat.history.push({ role: 'assistant', text: data.reply });
      add('assistant', data.reply);
      const tb = traceBlock(data.trace);
      if (tb) { log.append(tb); }
      for (const p of data.proposals || []) log.append(proposalCard(p));
      window.dispatchEvent(new Event('fc:changed'));
      scroll();
    } catch (err) {
      typing.remove();
      add('error', err.message);
    }
    busy = false; sendBtn.disabled = false; sendBtn.textContent = 'Send';
    input.focus();
  }

  if (!chat.history.length) {
    log.append(h('div', { class: 'msg assistant welcome' }, h('strong', { text: 'Hi, I’m your Freelance CFO agent. ' }),
      document.createTextNode('Paste a client’s message or tell me what to bill and I’ll prepare the PayPal invoice. Ask who hasn’t paid, how your cash flow looks, or have me review your collections and draft reminders. I can read your PayPal data freely, but I never send or change anything until you approve it.')));
  } else {
    log.append(h('div', { class: 'msg assistant welcome', text: 'Earlier conversation:' }));
    for (const m of chat.history) log.append(h('div', { class: `msg ${m.role}`, text: m.text }));
    log.append(h('div', { class: 'muted small', text: 'Approval cards from earlier requests are on the Approvals page.' }));
  }

  const chips = h('div', { class: 'chips', 'aria-label': 'Try an example' }, EXAMPLES.map((ex) => h('button', { type: 'button', class: 'chip', text: ex.label, onclick: () => { input.value = ex.text; input.focus(); } })));
  const form = h('form', { class: 'composer', autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input, sendBtn);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });

  root.append(h('section', { class: 'panel chat' }, log, chips, form));
  setTimeout(scroll, 0);

  if (state.pendingPrompt) { const p = state.pendingPrompt; state.pendingPrompt = ''; send(p); }
}