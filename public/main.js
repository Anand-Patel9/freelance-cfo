// App shell and router. Each page is a small module in /views loaded on demand.

import { api, h, icon, state, toast, loading, errorBox } from './ui.js';

const ROUTES = [
  { path: '/', title: 'Dashboard', icon: 'grid', nav: true, load: () => import('./views/dashboard.js') },
  { path: '/assistant', title: 'Assistant', icon: 'chat', nav: true, load: () => import('./views/assistant.js') },
  { path: '/invoices', title: 'Invoices', icon: 'file', nav: true, load: () => import('./views/invoice-list.js') },
  { path: '/invoices/:id', title: 'Invoice', parent: '/invoices', load: () => import('./views/invoice-detail.js') },
  { path: '/new', title: 'New invoice', icon: 'plus', nav: true, load: () => import('./views/new-invoice.js') },
  { path: '/clients', title: 'Clients', icon: 'users', nav: true, load: () => import('./views/clients.js') },
  { path: '/approvals', title: 'Approvals', icon: 'check', nav: true, badge: true, load: () => import('./views/approvals.js') },
  { path: '/activity', title: 'Activity', icon: 'activity', nav: true, load: () => import('./views/activity.js') },
  { path: '/settings', title: 'Settings', icon: 'sliders', nav: true, load: () => import('./views/settings.js') },
  { path: '/login', title: 'Sign in', public: true, load: () => import('./views/login.js') },
];

const view = document.getElementById('view');
let cleanup = null;
let renderToken = 0;

function match(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  for (const route of ROUTES) {
    const names = [];
    const re = new RegExp(`^${route.path.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    const m = re.exec(clean);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return { route: null, params: {} };
}

export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', to);
  else history.pushState({}, '', to);
  return render();
}

function buildNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...ROUTES.filter((r) => r.nav).map((r) => h('a', { href: r.path, 'data-link': true, 'data-path': r.path, class: 'nav-item' }, icon(r.icon), h('span', { text: r.title }), r.badge ? h('span', { class: 'badge-count', id: 'approvalBadge', hidden: true }) : null)));
}

function setActive(route) {
  const active = route?.parent || route?.path;
  for (const a of document.querySelectorAll('#nav .nav-item')) a.classList.toggle('active', a.dataset.path === active);
}

async function refreshBadge() {
  const badge = document.getElementById('approvalBadge');
  if (!badge || !state.session.authenticated) return;
  try {
    const { proposals } = await api('/api/proposals?status=pending');
    badge.textContent = String(proposals.length);
    badge.hidden = proposals.length === 0;
  } catch { /* the badge is a nicety */ }
}

async function refreshEnv() {
  try {
    const hd = await api('/api/health');
    Object.assign(state.limits, hd.limits || {});
    document.getElementById('envBadges').replaceChildren(
      h('span', { class: `badge ${hd.sandbox ? 'sandbox' : 'live'}`, text: hd.sandbox ? 'PayPal Sandbox · test money' : 'PayPal LIVE' }),
      h('span', { class: 'badge', text: `AI: ${String(hd.model || '').split(',')[0].trim()}` }),
      state.session.authRequired && state.session.authenticated
        ? h('button', { type: 'button', class: 'btn ghost small', text: 'Sign out', onclick: async () => { await api('/api/logout', { method: 'POST', body: {} }); state.session.authenticated = false; navigate('/login', { replace: true }); } })
        : null);
  } catch { /* shown on the Settings page if it matters */ }
}

async function render() {
  const token = ++renderToken;
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;

  let { route, params } = match(location.pathname);
  if (!route) { route = { path: '*', title: 'Not found', load: async () => ({ render(root) { root.append(h('div', { class: 'empty-state' }, h('h3', { text: 'Page not found' }), h('a', { class: 'btn primary', href: '/', 'data-link': true, text: 'Back to the dashboard' }))); } }) }; }
  if (state.session.authRequired && !state.session.authenticated && !route.public) {
    history.replaceState({}, '', '/login');
    ({ route, params } = match('/login'));
  }

  document.getElementById('shell').classList.toggle('auth-only', Boolean(route.public));
  document.getElementById('pageTitle').textContent = route.title;
  document.title = `${route.title} · Freelance CFO`;
  document.getElementById('topActions').replaceChildren();
  setActive(route);
  view.replaceChildren(loading());

  try {
    const mod = await route.load();
    if (token !== renderToken) return; // the user already moved on
    const root = h('div', { class: 'page' });
    const result = await mod.render(root, { params, query: new URLSearchParams(location.search), navigate, setActions: (...els) => document.getElementById('topActions').replaceChildren(...els) });
    if (token !== renderToken) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
    view.replaceChildren(root);
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    if (token !== renderToken) return;
    view.replaceChildren(errorBox(err.message || 'Something went wrong loading this page.', () => render()));
  }
  refreshBadge();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-link]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.origin);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});
window.addEventListener('popstate', render);
window.addEventListener('fc:changed', refreshBadge);
window.addEventListener('fc:auth-required', () => {
  if (location.pathname === '/login') return;
  state.session.authenticated = false;
  toast('Please sign in again.', 'bad');
  navigate('/login', { replace: true });
});

(async function boot() {
  buildNav();
  try {
    state.session = await api('/api/session');
  } catch { /* fall back to the defaults */ }
  await Promise.all([refreshEnv(), render()]);
  setInterval(refreshBadge, 30_000);
})();