const crypto = require('crypto');
const { SAML } = require('@node-saml/node-saml');
const { appUrl } = require('../utils/mail');
const { readCookie } = require('../utils/sessionCookies');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const COOKIE = 'sn_enterprise_browser';
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/enterprise' });
const pem = v => String(v || '').replace(/\\n/g, '\n');
const domains = () => String(process.env.ENTERPRISE_EMAIL_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
function https(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; } catch { return false; } }
function config() {
  const enabled = process.env.ENTERPRISE_SSO_ENABLED === 'true' && domains().length > 0 && (process.env.NODE_ENV !== 'production' || https(appUrl('/')));
  return { oidc: { enabled: !!(enabled && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && ['OIDC_ISSUER', 'OIDC_AUTHORIZATION_URL', 'OIDC_TOKEN_URL', 'OIDC_JWKS_URL'].every(k => https(process.env[k]))) }, saml: { enabled: !!(enabled && https(process.env.SAML_ENTRY_POINT) && process.env.SAML_IDP_ISSUER && process.env.SAML_IDP_CERT) } };
}
const providerKey = type => type + ':' + process.env[type === 'oidc' ? 'OIDC_ISSUER' : 'SAML_IDP_ISSUER'];
function passwordAllowed(user) {
  if (process.env.ENTERPRISE_SSO_REQUIRED !== 'true' || user.isPortalUser) return true;
  return String(process.env.ENTERPRISE_BREAK_GLASS_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).includes(user.email.toLowerCase());
}
function sameOrigin(req) {
  if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== new URL(appUrl('/')).origin && req.get('origin') !== `${req.protocol}://${req.get('host')}`)) fail('Start sign-in from Sales Nebula', 403);
}
function cache(db) {
  const take = async id => db.$transaction(async tx => {
    const row = await tx.samlRequest.findUnique({ where: { id } }); if (!row) return null;
    const claimed = await tx.samlRequest.deleteMany({ where: { id, value: row.value } }); return claimed.count && row.expiresAt > new Date() ? row.value : null;
  });
  return {
    saveAsync: async (id, value) => { await db.samlRequest.create({ data: { id, value, expiresAt: new Date(Date.now() + 600000) } }); return { value, createdAt: Date.now() }; },
    getAsync: async id => { const row = await db.samlRequest.findUnique({ where: { id } }); return row?.expiresAt > new Date() ? row.value : null; },
    removeAsync: async id => id ? take(id) : null, consumeAsync: take,
    saveIfAbsentAsync: async (id, value, expiresAtMs) => { try { await db.samlRequest.create({ data: { id, value, expiresAt: new Date(expiresAtMs) } }); return true; } catch (e) { if (e.code === 'P2002') return false; throw e; } },
  };
}
function saml(db, requestId) {
  const issuer = process.env.SAML_SP_ENTITY_ID || appUrl('/api/enterprise/saml/metadata');
  return new SAML({ entryPoint: process.env.SAML_ENTRY_POINT, issuer, audience: issuer, callbackUrl: appUrl('/api/enterprise/saml/acs'), idpIssuer: process.env.SAML_IDP_ISSUER, idpCert: pem(process.env.SAML_IDP_CERT),
    ...(process.env.SAML_SP_PRIVATE_KEY && { privateKey: pem(process.env.SAML_SP_PRIVATE_KEY), signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256' }),
    wantAssertionsSigned: true, wantAuthnResponseSigned: true, rejectReplayedAssertions: true, validateInResponseTo: 'always', acceptedClockSkewMs: 60000, maxAssertionAgeMs: 600000, requestIdExpirationPeriodMs: 600000,
    disableRequestedAuthnContext: true, identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', cacheProvider: cache(db), ...(requestId && { generateUniqueId: () => requestId }),
  });
}
async function start(db, req, res) {
  sameOrigin(req); const type = req.params.provider;
  if (!config()[type]?.enabled) fail('This enterprise sign-in provider is not configured', 503);
  const state = random(), browser = random(), nonce = random(), verifier = random();
  await db.enterpriseLoginAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } }); await db.samlRequest.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.enterpriseLoginAttempt.create({ data: { stateHash: hash(state), browserHash: hash(browser), provider: providerKey(type), nonce, verifier, expiresAt: new Date(Date.now() + 600000) } });
  res.cookie(COOKIE, browser, { ...cookieOptions(), maxAge: 600000 });
  if (type === 'saml') return { authorizationUrl: await saml(db, '_' + nonce).getAuthorizeUrlAsync(state, {}) };
  const url = new URL(process.env.OIDC_AUTHORIZATION_URL);
  for (const [k, v] of Object.entries({ client_id: process.env.OIDC_CLIENT_ID, response_type: 'code', redirect_uri: appUrl('/oauth/callback?enterprise=oidc'), scope: 'openid profile email', state, nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
  return { authorizationUrl: url.href };
}
let jwks;
let jwksUrl;
async function oidc(row, code) {
  const response = await fetch(process.env.OIDC_TOKEN_URL, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: process.env.OIDC_CLIENT_ID, client_secret: process.env.OIDC_CLIENT_SECRET, code, code_verifier: row.verifier, redirect_uri: appUrl('/oauth/callback?enterprise=oidc') }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) fail('Enterprise identity provider rejected the login code', 403);
  const tokens = await response.json(); if (typeof tokens.id_token !== 'string') fail('Enterprise identity provider did not return an ID token', 403);
  const jose = require('jose');
  if (!jwks || jwksUrl !== process.env.OIDC_JWKS_URL) { jwksUrl = process.env.OIDC_JWKS_URL; jwks = jose.createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 10000, cacheMaxAge: 600000 }); }
  let claims;
  try { claims = (await jose.jwtVerify(tokens.id_token, jwks, { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_CLIENT_ID, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'iat', 'sub', 'nonce'], clockTolerance: 60, maxTokenAge: '10m' })).payload; } catch { fail('Enterprise identity signature or claims could not be verified', 403); }
  if (claims.nonce !== row.nonce || (claims.azp && claims.azp !== process.env.OIDC_CLIENT_ID) || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== process.env.OIDC_CLIENT_ID)) fail('Enterprise login does not match this request', 403);
  return { subject: claims.sub, email: claims.email || claims.preferred_username, verified: claims.email_verified === true };
}
async function account(db, provider, identity) {
  if (typeof identity?.subject !== 'string' || !identity.subject || identity.subject.length > 500) fail('Enterprise identity has no stable subject', 403);
  const binding = await db.enterpriseIdentity.findUnique({ where: { provider_subject: { provider, subject: identity.subject } } });
  const include = { role: { include: { permissions: true } } };
  let user;
  if (binding) user = await db.user.findUnique({ where: { id: binding.userId }, include });
  else {
    const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
    if (!domains().includes(email.split('@')[1])) fail('This email domain is not enabled for enterprise sign-in', 403);
    const users = await db.user.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, include, take: 2 }); user = users.length === 1 ? users[0] : null;
    if (user && !identity.verified && !await db.scimIdentity.findUnique({ where: { userId: user.id } })) fail('Provision this user through SCIM before linking an unverified enterprise email', 403);
  }
  if (!user?.active || user.isPortalUser) fail('An active team account is required. Ask your administrator for access.', 403);
  if (!binding) {
    // One identity per user per configured issuer prevents a second subject silently taking it over.
    const existing = await db.enterpriseIdentity.findUnique({ where: { provider_userId: { provider, userId: user.id } } });
    if (existing && existing.subject !== identity.subject) fail('This account is already linked to a different enterprise identity', 403);
    await db.enterpriseIdentity.upsert({ where: { provider_subject: { provider, subject: identity.subject } }, create: { provider, subject: identity.subject, userId: user.id }, update: {} });
  }
  return user;
}
async function samlAcs(db, req, res) {
  if (!config().saml.enabled) fail('SAML is not configured', 503);
  const { RelayState: state, SAMLResponse } = req.body;
  if (typeof state !== 'string' || state.length > 200 || typeof SAMLResponse !== 'string' || SAMLResponse.length > 700000) fail('Invalid SAML response');
  const row = await db.enterpriseLoginAttempt.findUnique({ where: { stateHash: hash(state) } });
  if (!row || row.provider !== providerKey('saml') || row.expiresAt <= new Date() || row.ticketHash) fail('SAML request expired or was already used');
  let profile;
  try { const result = await saml(db).validatePostResponseAsync({ SAMLResponse }); if (result.loggedOut) fail('Unexpected logout response'); profile = result.profile; } catch { fail('SAML assertion signature, audience or request could not be verified', 403); }
  const assertion = profile?.getAssertion?.()?.Assertion;
  const responseTo = assertion?.Subject?.[0]?.SubjectConfirmation?.[0]?.SubjectConfirmationData?.[0]?.$?.InResponseTo;
  if (profile?.issuer !== process.env.SAML_IDP_ISSUER || responseTo !== '_' + row.nonce) fail('SAML assertion does not match this login request', 403);
  const email = profile.email || profile.mail || profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] || profile['urn:oid:0.9.2342.19200300.100.1.3'];
  const identity = { subject: profile.nameID, email, verified: true };
  if (typeof identity.subject !== 'string' || typeof identity.email !== 'string') fail('Configure a persistent NameID and an email attribute in the identity provider', 403);
  const ticket = random();
  const claimed = await db.enterpriseLoginAttempt.updateMany({ where: { stateHash: row.stateHash, ticketHash: null, expiresAt: { gt: new Date() } }, data: { ticketHash: hash(ticket), identity } });
  if (!claimed.count) fail('SAML response was already used', 409);
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  res.redirect(303, appUrl('/oauth/callback?enterprise=saml&state=' + encodeURIComponent(state) + '&ticket=' + encodeURIComponent(ticket)));
}
async function callback(db, req, res) {
  sameOrigin(req); const { state, code, ticket, error, enterprise: type } = req.body || {}, browser = readCookie(req, COOKIE);
  if (!['oidc', 'saml'].includes(type) || typeof state !== 'string' || state.length > 200 || !browser) fail('This enterprise login expired. Start again.');
  const row = await db.enterpriseLoginAttempt.findUnique({ where: { stateHash: hash(state) } });
  if (!row || row.browserHash !== hash(browser) || row.expiresAt <= new Date() || row.provider !== providerKey(type)) fail('This enterprise login expired or belongs to another browser');
  if (!config()[type].enabled) fail('This enterprise provider is no longer enabled', 503);
  if (type === 'saml' && (typeof ticket !== 'string' || hash(ticket) !== row.ticketHash)) fail('SAML login ticket is invalid', 403);
  const claimed = await db.enterpriseLoginAttempt.deleteMany({ where: { stateHash: row.stateHash, browserHash: row.browserHash, expiresAt: { gt: new Date() } } });
  if (!claimed.count) fail('Enterprise login response was already used', 409);
  res.clearCookie(COOKIE, cookieOptions());
  if (error) fail('Enterprise sign-in was cancelled or denied');
  if (type === 'oidc' && (typeof code !== 'string' || !code || code.length > 8192)) fail('Missing enterprise login code');
  const identity = type === 'saml' ? row.identity : await oidc(row, code);
  const user = await account(db, row.provider, identity);
  req.headers['x-session-mode'] = 'cookie'; return require('../routes/auth').completeSignIn(db, user, req, res, 'enterprise');
}
module.exports = { config, passwordAllowed, start, callback, samlAcs, saml, cache, account, oidc };
