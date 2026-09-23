/**
 * Connected-app OAuth: the authorization-code grant, with PKCE.
 *
 * An administrator registers an app, with the redirect URIs and scopes it may
 * use. The app sends the user's browser to /oauth/authorize, where the user,
 * signed in to Sales Nebula, sees what the app asks for and allows or denies
 * it. Allowing issues a single-use code, sent to a registered redirect URI;
 * the app trades the code, its client secret and its PKCE verifier at
 * /api/connected-apps/oauth/token for an access token (one hour) and a
 * refresh token (thirty days, renewed with each use).
 *
 * The token endpoint used to take `code` to be a user id and sign a session
 * token for whoever it named, so one app's client secret was enough to become
 * any user. Nothing is issued now without that user's consent, and client
 * secrets, codes and tokens are all stored as SHA-256 hashes.
 *
 * Scopes, each within the user's own permissions:
 *   read   GET and HEAD requests
 *   write  any request
 * Whatever its scope, an app token never reaches the user's own sign-in and
 * credentials (/api/auth, but for GET /api/auth/me), security settings such
 * as MFA devices and SSO (/api/security), API keys, or connected apps, where
 * it could authorize itself or another app.
 */
const crypto = require('crypto');

const SCOPES = {
  read: 'See the records you can see',
  write: 'Create, change and delete the records you can change',
};

const ACCESS_TOKEN_PREFIX = 'sno_at_';
const REFRESH_TOKEN_PREFIX = 'sno_rt_';
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// RFC 7636: a verifier is 43-128 unreserved characters, and an S256
// challenge is the unpadded base64url of its SHA-256, always 43 characters.
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * An error the OAuth endpoints report as { error, error_description }.
 * `redirectable` says whether it may be sent back to the app's redirect URI:
 * never when the client or the redirect URI itself is in doubt.
 */
class OAuthError extends Error {
  constructor(error, description, { status = 400, redirectable = false } = {}) {
    super(description);
    this.error = error;
    this.status = status;
    this.redirectable = redirectable;
  }
}

const digest = raw => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newSecret = prefix => prefix + crypto.randomBytes(32).toString('base64url');
/** A client secret, in the format apps have always been given. */
const newClientSecret = () => `sn_secret_${crypto.randomBytes(32).toString('hex')}`;

function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * A redirect URI an app may register: https, or plain http to this machine
 * for local development (RFC 8252), with no fragment and no credentials.
 */
function validRedirectUri(uri) {
  let url;
  try { url = new URL(String(uri)); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** An app's registered scopes that this server knows. */
const appScopes = app => (app.scopes || []).filter(s => SCOPES[s]);

/** The space-separated `scope` an app asked for, checked against what it may have. */
function requestedScopes(app, scope) {
  const allowed = appScopes(app);
  const asked = String(scope || '').split(' ').filter(Boolean);
  if (!asked.length) {
    if (!allowed.length) throw new OAuthError('invalid_scope', 'The app has no scopes registered', { redirectable: true });
    return allowed;
  }
  const unknown = asked.filter(s => !allowed.includes(s));
  if (unknown.length) {
    throw new OAuthError('invalid_scope', `Scope not available to this app: ${unknown.join(' ')}`, { redirectable: true });
  }
  return [...new Set(asked)].sort();
}

/**
 * The checks every authorization request gets, before consent and again when
 * the user decides. Returns what the consent screen shows and the code needs.
 */
async function checkAuthorizationRequest(prisma, params) {
  const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = params;
  const app = client_id ? await prisma.connectedApp.findUnique({ where: { clientId: String(client_id) } }) : null;
  if (!app || !app.active || app.revokedAt) {
    throw new OAuthError('invalid_client', 'This app is not registered, or has been disabled');
  }
  // Only a registered URI, matched exactly. Anything looser lets another
  // site collect the code.
  if (!redirect_uri || !app.redirectUris.includes(redirect_uri) || !validRedirectUri(redirect_uri)) {
    throw new OAuthError('invalid_request', 'The redirect_uri is not registered for this app');
  }

  const redirectable = { redirectable: true };
  if (response_type !== 'code') {
    throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported', redirectable);
  }
  // PKCE is required of every app: a code intercepted on its way back is
  // then worthless without the verifier only the app holds.
  if (code_challenge_method !== 'S256' || !S256_CHALLENGE.test(String(code_challenge || ''))) {
    throw new OAuthError('invalid_request', 'A PKCE code_challenge with code_challenge_method=S256 is required', redirectable);
  }
  const scopes = requestedScopes(app, scope);
  return { app, redirectUri: redirect_uri, scopes, state: state == null ? undefined : String(state), codeChallenge: code_challenge };
}

/** The redirect URI with the given parameters added to its query. */
function redirectWith(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Store a code for a consent just given; returns the code itself, once. */
async function issueCode(prisma, { app, userId, redirectUri, scopes, codeChallenge }) {
  const code = crypto.randomBytes(32).toString('base64url');
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash: digest(code), appId: app.id, userId, redirectUri, scopes, codeChallenge,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}

/**
 * The app presenting a client secret, by HTTP Basic or in the body
 * (RFC 6749 2.3.1). Throws invalid_client (a 401).
 */
async function authenticateClient(prisma, req) {
  let clientId = req.body?.client_id;
  let clientSecret = req.body?.client_secret;
  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    clientId = null;
    if (colon > 0) {
      try {
        clientId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '));
        clientSecret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '));
      } catch { clientId = null; }
    }
  }
  const app = clientId ? await prisma.connectedApp.findUnique({ where: { clientId: String(clientId) } }) : null;
  const matches = sameHash(digest(clientSecret || ''), app?.clientSecretHash);
  if (!app || !clientSecret || !matches || !app.active || app.revokedAt) {
    throw new OAuthError('invalid_client', 'Client authentication failed', { status: 401 });
  }
  return app;
}

const activeUser = async (prisma, userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { active: true } });
  return !!user?.active;
};

/** A new grant row: the tokens themselves are returned, only their hashes kept. */
async function issueTokens(prisma, { appId, userId, scopes }) {
  // Grants whose refresh token has lapsed can never be used again.
  await prisma.oAuthToken.deleteMany({ where: { appId, userId, refreshExpiresAt: { lt: new Date() } } });
  const accessToken = newSecret(ACCESS_TOKEN_PREFIX);
  const refreshToken = newSecret(REFRESH_TOKEN_PREFIX);
  await prisma.oAuthToken.create({
    data: {
      appId, userId, scopes,
      accessTokenHash: digest(accessToken),
      refreshTokenHash: digest(refreshToken),
      expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return tokenResponse(accessToken, refreshToken, scopes);
}

const tokenResponse = (accessToken, refreshToken, scopes) => ({
  access_token: accessToken,
  token_type: 'Bearer',
  expires_in: ACCESS_TTL_S,
  refresh_token: refreshToken,
  scope: scopes.join(' '),
});

/** grant_type=authorization_code. */
async function redeemCode(prisma, app, { code, redirect_uri, code_verifier }) {
  if (!code || !redirect_uri || !code_verifier) {
    throw new OAuthError('invalid_request', 'code, redirect_uri and code_verifier are required');
  }
  const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: digest(code) } });
  const invalid = () => new OAuthError('invalid_grant', 'The authorization code is invalid, expired or already used');
  if (!row || row.appId !== app.id) throw invalid();

  // A code presented twice may have been stolen, so whatever it bought goes
  // too (RFC 6749 4.1.2).
  if (row.usedAt) {
    await prisma.oAuthToken.deleteMany({ where: { appId: app.id, userId: row.userId } });
    throw invalid();
  }
  if (row.expiresAt <= new Date()) throw invalid();
  if (row.redirectUri !== redirect_uri) throw invalid();
  const challenge = VERIFIER.test(String(code_verifier))
    ? crypto.createHash('sha256').update(String(code_verifier)).digest('base64url')
    : '';
  if (!sameHash(challenge, row.codeChallenge)) throw invalid();

  // Spent atomically: of two requests racing with the same code, one wins.
  const spent = await prisma.oAuthAuthorizationCode.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (spent.count !== 1) throw invalid();

  if (!(await activeUser(prisma, row.userId))) throw invalid();
  // The app's scopes may have been narrowed since the user consented.
  const scopes = row.scopes.filter(s => appScopes(app).includes(s));
  if (!scopes.length) throw invalid();
  return issueTokens(prisma, { appId: app.id, userId: row.userId, scopes });
}

/** grant_type=refresh_token. The refresh token is replaced with each use. */
async function refreshGrant(prisma, app, { refresh_token, scope }) {
  const invalid = () => new OAuthError('invalid_grant', 'The refresh token is invalid or expired');
  if (!String(refresh_token || '').startsWith(REFRESH_TOKEN_PREFIX)) throw invalid();
  const oldHash = digest(refresh_token);
  const row = await prisma.oAuthToken.findUnique({ where: { refreshTokenHash: oldHash } });
  if (!row || row.appId !== app.id || !row.refreshExpiresAt || row.refreshExpiresAt <= new Date()) throw invalid();
  if (!(await activeUser(prisma, row.userId))) throw invalid();

  let scopes = row.scopes.filter(s => appScopes(app).includes(s));
  if (scope) {
    // A refresh may narrow the grant, never widen it (RFC 6749 6).
    const asked = [...new Set(String(scope).split(' ').filter(Boolean))];
    if (asked.some(s => !scopes.includes(s))) throw new OAuthError('invalid_scope', 'A refresh cannot add scopes');
    scopes = asked.sort();
  }
  if (!scopes.length) throw invalid();

  const accessToken = newSecret(ACCESS_TOKEN_PREFIX);
  const refreshToken = newSecret(REFRESH_TOKEN_PREFIX);
  const rotated = await prisma.oAuthToken.updateMany({
    where: { id: row.id, refreshTokenHash: oldHash },
    data: {
      scopes,
      accessTokenHash: digest(accessToken),
      refreshTokenHash: digest(refreshToken),
      expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  if (rotated.count !== 1) throw invalid();
  return tokenResponse(accessToken, refreshToken, scopes);
}

/**
 * RFC 7009: revoking either token ends the whole grant. An unknown token is
 * not an error, and an app can only revoke its own.
 */
async function revokeToken(prisma, app, token) {
  if (!token) return 0;
  const hash = digest(token);
  const { count } = await prisma.oAuthToken.deleteMany({
    where: { appId: app.id, OR: [{ accessTokenHash: hash }, { refreshTokenHash: hash }] },
  });
  return count;
}

/** Everything an app's grants and codes leave behind when it is revoked or deleted. */
async function endAppGrants(prisma, appId) {
  await prisma.oAuthToken.deleteMany({ where: { appId } });
  await prisma.oAuthAuthorizationCode.deleteMany({ where: { appId } });
}

/**
 * The live grant behind an access token, or { reason } when there is none.
 * The app must still be active, and scopes an administrator has since taken
 * from it are gone at once. The user is the caller's to check.
 */
async function findAccessGrant(prisma, accessToken) {
  const row = await prisma.oAuthToken.findUnique({ where: { accessTokenHash: digest(accessToken) } });
  if (!row) return { reason: 'invalid' };
  if (row.expiresAt <= new Date()) return { reason: 'expired' };
  const app = await prisma.connectedApp.findUnique({ where: { id: row.appId }, select: { active: true, revokedAt: true, scopes: true } });
  if (!app || !app.active || app.revokedAt) return { reason: 'invalid' };
  return { grant: { ...row, scopes: row.scopes.filter(s => appScopes(app).includes(s)) } };
}

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Why an app token may not make this request, or null when it may. Routes
 * are matched without regard to case, as Express matches them.
 */
function appTokenRefusal(req, scopes) {
  const path = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase().replace(/\/+$/, '');
  const safe = SAFE_METHODS.has(req.method);
  if (under(path, '/api/auth') && !(safe && path === '/api/auth/me')) {
    return 'Connected apps cannot use the account and sign-in endpoints';
  }
  // Security settings (MFA devices, SSO, sessions, IP rules), API keys and
  // connected apps: an app could use any of them to outlast its own grant.
  if (['/api/security', '/api/admin/api-keys', '/api/connected-apps'].some(prefix => under(path, prefix))) {
    return 'Connected apps cannot manage security settings, API keys or connected apps';
  }
  const needed = safe ? ['read', 'write'] : ['write'];
  if (!scopes.some(s => needed.includes(s))) {
    return `This request needs the ${safe ? 'read' : 'write'} scope`;
  }
  return null;
}

module.exports = {
  SCOPES, ACCESS_TOKEN_PREFIX, OAuthError,
  validRedirectUri, checkAuthorizationRequest, redirectWith, issueCode,
  authenticateClient, redeemCode, refreshGrant, revokeToken, endAppGrants,
  findAccessGrant, appTokenRefusal, newClientSecret, digest,
};
