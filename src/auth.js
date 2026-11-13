// Optional password protection for hosted deployments (set APP_PASSWORD).
// Stateless signed cookie: "<expiry>.<hmac>". No user database needed.

import crypto from 'node:crypto';

const COOKIE = 'fc_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest();

export function createAuth({ password, secret, now = () => Date.now() }) {
  const enabled = Boolean(password);
  const key = crypto.createHash('sha256').update(`${secret || ''}|${password || ''}`).digest();

  const sign = (expiry) => crypto.createHmac('sha256', key).update(String(expiry)).digest('hex');

  function readCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return '';
  }

  function isAuthenticated(req) {
    if (!enabled) return true;
    const [expiry, mac] = readCookie(req).split('.');
    if (!expiry || !mac || Number(expiry) < now()) return false;
    const expected = sign(expiry);
    return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  }

  function checkPassword(attempt) {
    return enabled && crypto.timingSafeEqual(sha(attempt ?? ''), sha(password));
  }

  function issue(req, res) {
    const expiry = now() + MAX_AGE_MS;
    const secure = req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${expiry}.${sign(expiry)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_MS / 1000}${secure}`);
  }

  function clear(res) {
    res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  return { enabled, isAuthenticated, checkPassword, issue, clear };
}