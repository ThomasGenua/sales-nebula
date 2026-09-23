/**
 * Browser sessions in httpOnly cookies, with double-submit CSRF protection.
 *
 * The browser app used to keep its access and refresh tokens in localStorage,
 * where any script that found its way into the page could read them and use
 * them from anywhere for a week. It now asks for a cookie session
 * (`X-Session-Mode: cookie` at sign-in): the tokens travel only in httpOnly
 * cookies that page scripts cannot read, and the response body carries none.
 *
 * A cookie rides along on every request the browser makes, a forged
 * cross-site one included, so a cookie-authenticated request that changes
 * anything must also send the sn_csrf cookie's value in X-CSRF-Token. A page
 * on another site can make the browser send the cookie but cannot read it
 * and so cannot copy it into the header.
 *
 * Bearer tokens and API keys work exactly as before: scripts and tests that
 * never ask for a cookie session are unaffected, and a header they set
 * themselves cannot be forged by another site.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_COOKIE = 'sn_access';
const REFRESH_COOKIE = 'sn_refresh';
const CSRF_COOKIE = 'sn_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const secure = () => process.env.NODE_ENV === 'production';

/** Cookie header -> { name: value }. */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* malformed; skip */ }
  }
  return out;
}

const readCookie = (req, name) => parseCookies(req.headers.cookie)[name] || null;

/** Whether the caller asked for its session in cookies rather than the body. */
const wantsCookieSession = req => String(req.get('x-session-mode') || '').toLowerCase() === 'cookie';

/** Milliseconds until a JWT expires, for the cookie that carries it. */
function lifetimeMs(token) {
  const exp = jwt.decode(token)?.exp;
  return exp ? Math.max(0, exp * 1000 - Date.now()) : undefined;
}

/**
 * Set the session cookies. The refresh cookie is only ever sent to
 * /api/auth, and the CSRF token is renewed with every session it guards.
 */
function setSessionCookies(res, { accessToken, refreshToken }) {
  const base = { httpOnly: true, secure: secure(), sameSite: 'lax' };
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: '/api', maxAge: lifetimeMs(accessToken) });
  if (refreshToken) {
    const refreshMs = lifetimeMs(refreshToken);
    res.cookie(REFRESH_COOKIE, refreshToken, { ...base, sameSite: 'strict', path: '/api/auth', maxAge: refreshMs });
    // Readable by the page on purpose: echoing it back is the proof that a
    // request came from the page and not from another site.
    res.cookie(CSRF_COOKIE, crypto.randomBytes(32).toString('hex'), { secure: secure(), sameSite: 'lax', path: '/', maxAge: refreshMs });
  }
}

function clearSessionCookies(res) {
  const base = { secure: secure(), sameSite: 'lax' };
  res.clearCookie(ACCESS_COOKIE, { ...base, httpOnly: true, path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...base, httpOnly: true, sameSite: 'strict', path: '/api/auth' });
  res.clearCookie(CSRF_COOKIE, { ...base, path: '/' });
}

/** Whether X-CSRF-Token matches the sn_csrf cookie. */
function csrfValid(req) {
  const cookie = readCookie(req, CSRF_COOKIE);
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A cookie-authenticated request that changes state must carry the CSRF token. */
const needsCsrf = req => !SAFE_METHODS.has(req.method);

module.exports = {
  ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE,
  parseCookies, readCookie, wantsCookieSession,
  setSessionCookies, clearSessionCookies, csrfValid, needsCsrf,
};
