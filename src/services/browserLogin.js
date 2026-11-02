const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { readCookie } = require('../utils/sessionCookies');
const { appUrl } = require('../utils/mail');
const COOKIE = 'sn_oauth_browser';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/oauth' });
function config() {
  const tenant = String(process.env.MICROSOFT_TENANT_ID || '').trim().toLowerCase();
  const enabled = process.env.OAUTH_LOGIN_ENABLED === 'true';
  return {
    google: { enabled: enabled && !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET },
    microsoft: { enabled: enabled && !!process.env.MICROSOFT_CLIENT_ID && !!process.env.MICROSOFT_CLIENT_SECRET && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(tenant) },
  };
}
function sameOrigin(req) {
  if (req.get('sec-fetch-site') === 'cross-site') fail('Start sign-in from Sales Nebula', 403);
  const origin = req.get('origin');
  if (origin && origin !== new URL(appUrl('/')).origin && origin !== `${req.protocol}://${req.get('host')}`) fail('Start sign-in from Sales Nebula', 403);
}
async function start(db, req, res) {
  sameOrigin(req);
  const provider = req.params.provider;
  if (!Object.hasOwn(config(), provider) || !config()[provider].enabled) fail('This sign-in provider is not configured', 503);
  const state = random(), browser = random(), verifier = random(), nonce = random();
  await db.oAuthLoginAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.oAuthLoginAttempt.create({ data: { stateHash: hash(state), browserHash: hash(browser), provider, verifier, nonce, expiresAt: new Date(Date.now() + 600000) } });
  res.cookie(COOKIE, browser, { ...cookieOptions(), maxAge: 600000 });
  const microsoft = provider === 'microsoft';
  const url = new URL(microsoft ? `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID.trim()}/oauth2/v2.0/authorize` : 'https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: process.env[microsoft ? 'MICROSOFT_CLIENT_ID' : 'GOOGLE_CLIENT_ID'], redirect_uri: appUrl('/oauth/callback'), response_type: 'code', response_mode: 'query', scope: microsoft ? 'openid profile email User.Read' : 'openid email profile', state, nonce, code_challenge: hashBase64(verifier), code_challenge_method: 'S256', prompt: 'select_account' });
  return { authorizationUrl: url.href };
}
function hashBase64(value) { return crypto.createHash('sha256').update(value).digest('base64url'); }
async function callback(db, req, res) {
  sameOrigin(req);
  const { state, code, error } = req.body || {};
  const browser = readCookie(req, COOKIE);
  if (typeof state !== 'string' || state.length > 200 || !browser) fail('This sign-in request expired. Start again.');
  const row = await db.oAuthLoginAttempt.findUnique({ where: { stateHash: hash(state) } });
  if (!row || row.expiresAt <= new Date() || row.browserHash !== hash(browser)) fail('This sign-in request expired or belongs to another browser. Start again.');
  const claimed = await db.oAuthLoginAttempt.deleteMany({ where: { stateHash: row.stateHash, browserHash: row.browserHash, expiresAt: { gt: new Date() } } });
  if (!claimed.count) fail('This sign-in response has already been used. Start again.');
  res.clearCookie(COOKIE, cookieOptions());
  if (error) fail('Provider sign-in was cancelled or denied. You can try again.');
  if (typeof code !== 'string' || !code || code.length > 8192) fail('Missing sign-in code. Start again.');
  if (!config()[row.provider].enabled) fail('This sign-in provider is no longer enabled', 503);
  const microsoft = row.provider === 'microsoft';
  const tenant = String(process.env.MICROSOFT_TENANT_ID || '').trim().toLowerCase();
  const clientId = process.env[microsoft ? 'MICROSOFT_CLIENT_ID' : 'GOOGLE_CLIENT_ID'];
  const response = await fetch(microsoft ? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token` : 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({ code, client_id: clientId, client_secret: process.env[microsoft ? 'MICROSOFT_CLIENT_SECRET' : 'GOOGLE_CLIENT_SECRET'], redirect_uri: appUrl('/oauth/callback'), grant_type: 'authorization_code', code_verifier: row.verifier }),
  });
  if (!response.ok) fail('Provider could not complete sign-in. Start again.');
  const tokens = await response.json();
  let email;
  if (!microsoft) {
    const { OAuth2Client } = require('google-auth-library');
    const ticket = await new OAuth2Client(clientId).verifyIdToken({ idToken: tokens.id_token, audience: clientId });
    const claims = ticket.getPayload();
    if (claims.nonce !== row.nonce || claims.email_verified !== true) fail('Google identity could not be verified', 403);
    email = claims.email;
  } else {
    // Code was exchanged directly with the pinned tenant over TLS (OIDC 3.1.3.7).
    const claims = jwt.decode(tokens.id_token || '') || {};
    if (claims.nonce !== row.nonce || claims.aud !== clientId || claims.iss !== `https://login.microsoftonline.com/${tenant}/v2.0` || String(claims.tid).toLowerCase() !== tenant || !(claims.exp > Date.now() / 1000) || !tokens.access_token) fail('Microsoft identity could not be verified', 403);
    const profile = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(20000) });
    if (!profile.ok) fail('Microsoft profile could not be loaded', 502);
    const data = await profile.json();
    // Bind the Graph user to the same OIDC identity before using its address.
    if (!claims.oid || data.id !== claims.oid) fail('Microsoft profile does not match the sign-in identity', 403);
    email = data.mail || data.userPrincipalName;
  }
  const { findAccountByEmail, completeSignIn } = require('../routes/auth');
  const user = typeof email === 'string' && await findAccountByEmail(db, email, { include: { role: { include: { permissions: true } } } });
  if (!user || !user.active || user.isPortalUser) fail('An active team account is required. Ask your administrator for an invite.', 403);
  req.headers['x-session-mode'] = 'cookie';
  return completeSignIn(db, user, req, res, 'sso');
}
module.exports = { start, callback, config };
