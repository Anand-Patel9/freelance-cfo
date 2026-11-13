import { api, h, state } from '../ui.js';

export function render(root, { navigate }) {
  const password = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Password' });
  const error = h('div', { class: 'notice bad', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary wide', text: 'Sign in' });
  const form = h('form', { class: 'login-card', onsubmit: async (e) => {
    e.preventDefault(); error.hidden = true; submit.disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { password: password.value } });
      state.session.authenticated = true;
      window.dispatchEvent(new Event('fc:changed'));
      navigate('/', { replace: true });
      location.reload();
    } catch (err) { error.textContent = err.message; error.hidden = false; submit.disabled = false; password.select(); }
  } },
  h('div', { class: 'logo big', 'aria-hidden': 'true', text: 'FC' }),
  h('h2', { text: 'Freelance CFO' }),
  h('p', { class: 'muted', text: 'Sign in to manage invoices and collections.' }),
  h('div', { class: 'field' }, h('label', { for: 'pw', text: 'Password' }), password), error, submit);
  root.append(h('div', { class: 'login-wrap' }, form));
  setTimeout(() => password.focus(), 0);
}