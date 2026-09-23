const { Router } = require('express');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { statusRoutes } = require('../utils/moduleStatus');
const oauth = require('../services/oauth');

const router = Router();

/** An app as an administrator sees it: never its secret, or a hash of one. */
const present = ({ clientSecretHash, apiTokenHash, ...app }) => app;

/**
 * The fields an administrator sets. The client id and secret, the creator and
 * the revocation are the server's, and all of it used to pass straight
 * through from the request body.
 */
function appFields(body, { creating }) {
  const b = body || {};
  const data = {};
  if (creating || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { error: 'name is required' };
    data.name = b.name.trim();
  }
  for (const key of ['description', 'logoUrl']) {
    if (b[key] !== undefined) data[key] = b[key] ? String(b[key]) : null;
  }
  if (b.active !== undefined) data.active = !!b.active;
  if (b.redirectUris !== undefined) {
    if (!Array.isArray(b.redirectUris) || b.redirectUris.some(u => !oauth.validRedirectUri(u))) {
      return { error: 'redirectUris must be https URLs, or http on localhost, with no fragment' };
    }
    data.redirectUris = [...new Set(b.redirectUris)];
  }
  if (b.scopes !== undefined) {
    if (!Array.isArray(b.scopes) || !b.scopes.length || b.scopes.some(s => !oauth.SCOPES[s])) {
      return { error: `scopes must be one or more of: ${Object.keys(oauth.SCOPES).join(', ')}` };
    }
    data.scopes = [...new Set(b.scopes)];
  }
  return { data };
}

/** A line in the app's usage log. Never fails the request it describes. */
const logAppEvent = (prisma, connectedAppId, action, details) =>
  prisma.connectedAppLog.create({ data: { connectedAppId, action, status: 'success', details } }).catch(() => {});

// ─── APP MANAGEMENT (Admin) ───
router.get('/', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const apps = await req.app.locals.prisma.connectedApp.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: apps.map(present) });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const { data, error } = appFields(req.body, { creating: true });
    if (error) return res.status(400).json({ error });
    const clientSecret = oauth.newClientSecret();
    const app = await req.app.locals.prisma.connectedApp.create({
      data: {
        ...data,
        clientId: `sn_${uuid().replace(/-/g, '')}`,
        clientSecretHash: oauth.digest(clientSecret),
        createdById: req.userId,
      },
    });
    // The secret is shown this once; only its hash is kept.
    res.status(201).json({ ...present(app), clientSecret });
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { data, error } = appFields(req.body, { creating: false });
    if (error) return res.status(400).json({ error });
    if (data.active === true) Object.assign(data, { revokedAt: null, revokedById: null });
    const app = await prisma.connectedApp.update({ where: { id: req.params.id }, data });
    // Switching an app off ends every grant; switching it back on revives none.
    if (data.active === false) await oauth.endAppGrants(prisma, app.id);
    res.json(present(app));
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.connectedApp.delete({ where: { id: req.params.id } });
    await oauth.endAppGrants(prisma, req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── OAUTH 2.0: THE USER'S CONSENT ───
// The consent screen, /oauth/authorize in the browser app, asks what an
// authorization request is for, then posts the user's decision. Both take the
// user's own session: an API key or an app's token cannot consent for anyone.

const requireUserSession = (req, res, next) => {
  if (req.isApiKey || req.isAppToken) return res.status(403).json({ error: 'Authorizing an app takes your own sign-in' });
  next();
};

/**
 * A failed authorization request. Once the app and its redirect URI check
 * out, the app hears why at that URI (RFC 6749 4.1.2.1); until then only the
 * user is told, so nothing goes to an address the app never registered.
 */
function authorizationFailure(res, err, params) {
  if (err.redirectable) {
    return res.json({
      error: err.error,
      error_description: err.message,
      redirectTo: oauth.redirectWith(params.redirect_uri, { error: err.error, error_description: err.message, state: params.state }),
    });
  }
  return res.status(400).json({ error: err.message, code: err.error });
}

router.get('/oauth/authorize', authenticate, requireUserSession, async (req, res, next) => {
  try {
    const request = await oauth.checkAuthorizationRequest(req.app.locals.prisma, req.query);
    res.set('Cache-Control', 'no-store');
    res.json({
      app: { name: request.app.name, description: request.app.description },
      scopes: request.scopes.map(name => ({ name, description: oauth.SCOPES[name] })),
      redirectOrigin: new URL(request.redirectUri).origin,
    });
  } catch (err) {
    if (err instanceof oauth.OAuthError) return authorizationFailure(res, err, req.query);
    next(err);
  }
});

router.post('/oauth/authorize', authenticate, requireUserSession, auditMiddleware, async (req, res, next) => {
  const params = req.body || {};
  try {
    const prisma = req.app.locals.prisma;
    // Checked afresh: the consent screen may have sat open while an
    // administrator disabled the app or changed its redirect URIs.
    const request = await oauth.checkAuthorizationRequest(prisma, params);
    res.set('Cache-Control', 'no-store');
    if (params.decision !== 'allow') {
      await logAppEvent(prisma, request.app.id, 'authorization_denied', `Denied by user ${req.user.id}`);
      return res.json({
        redirectTo: oauth.redirectWith(request.redirectUri, { error: 'access_denied', error_description: 'The user denied the request', state: request.state }),
      });
    }
    const code = await oauth.issueCode(prisma, {
      app: request.app, userId: req.user.id, redirectUri: request.redirectUri,
      scopes: request.scopes, codeChallenge: request.codeChallenge,
    });
    await req.audit({ action: 'authorize', module: 'connectedApps', recordId: request.app.id, details: `Authorized ${request.app.name}: ${request.scopes.join(' ')}` });
    await logAppEvent(prisma, request.app.id, 'authorized', `Scopes ${request.scopes.join(' ')} for user ${req.user.id}`);
    res.json({ redirectTo: oauth.redirectWith(request.redirectUri, { code, state: request.state }) });
  } catch (err) {
    if (err instanceof oauth.OAuthError) return authorizationFailure(res, err, params);
    next(err);
  }
});

// ─── OAUTH 2.0: THE APP'S ENDPOINTS ───
// Called by the app's server with its client credentials, by HTTP Basic or
// client_id and client_secret in the form body.

function oauthFailure(req, res, next, err) {
  if (!(err instanceof oauth.OAuthError)) return next(err);
  if (err.status === 401 && (req.get('authorization') || '').startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="connected-apps"');
  }
  res.status(err.status).json({ error: err.error, error_description: err.message });
}

// POST /connected-apps/oauth/token
router.post('/oauth/token', async (req, res, next) => {
  // Tokens are never to be cached (RFC 6749 5.1).
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  try {
    const prisma = req.app.locals.prisma;
    const app = await oauth.authenticateClient(prisma, req);
    const grantType = req.body?.grant_type;
    let tokens;
    if (grantType === 'authorization_code') {
      tokens = await oauth.redeemCode(prisma, app, req.body);
      await logAppEvent(prisma, app.id, 'token_issued', `Scopes ${tokens.scope}`);
    } else if (grantType === 'refresh_token') {
      tokens = await oauth.refreshGrant(prisma, app, req.body);
    } else {
      throw new oauth.OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
    res.json(tokens);
  } catch (err) { oauthFailure(req, res, next, err); }
});

// POST /connected-apps/oauth/revoke (RFC 7009). Revoking either token ends
// the grant. The answer is the same whether or not the token was known.
router.post('/oauth/revoke', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await oauth.authenticateClient(prisma, req);
    if (await oauth.revokeToken(prisma, app, req.body?.token)) {
      await logAppEvent(prisma, app.id, 'token_revoked', 'Revoked by the app');
    }
    res.json({ success: true });
  } catch (err) { oauthFailure(req, res, next, err); }
});

// ─── THE APPS A USER HAS AUTHORIZED ───
router.get('/authorizations', authenticate, requireUserSession, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const grants = await prisma.oAuthToken.findMany({
      where: { userId: req.user.id, refreshExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
    });
    const apps = await prisma.connectedApp.findMany({
      where: { id: { in: [...new Set(grants.map(g => g.appId))] } },
      select: { id: true, name: true, description: true },
    });
    const data = apps.map(app => {
      const mine = grants.filter(g => g.appId === app.id);
      return {
        appId: app.id,
        name: app.name,
        description: app.description,
        scopes: [...new Set(mine.flatMap(g => g.scopes))].sort(),
        authorizedAt: mine[0].createdAt,
      };
    });
    res.json({ data });
  } catch (err) { next(err); }
});

router.delete('/authorizations/:appId', authenticate, requireUserSession, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { appId: req.params.appId, userId: req.user.id };
    const { count } = await prisma.oAuthToken.deleteMany({ where });
    await prisma.oAuthAuthorizationCode.deleteMany({ where });
    if (count) {
      await req.audit({ action: 'revoke', module: 'connectedApps', recordId: req.params.appId, details: 'User revoked their authorization' });
      await logAppEvent(prisma, req.params.appId, 'token_revoked', `Revoked by user ${req.user.id}`);
    }
    res.json({ success: true, revoked: count });
  } catch (err) { next(err); }
});

// App usage stats
router.get('/:id/usage', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.connectedApp.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    const logs = await prisma.connectedAppLog.findMany({ where: { connectedAppId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ appId: app.id, name: app.name, totalCalls: logs.length, lastUsed: logs[0]?.createdAt, logs: logs.slice(0, 10) });
  } catch (err) { next(err); }
});

// Revoke app access: the app stops working, and every grant to it ends.
router.post('/:id/revoke', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const updated = await prisma.connectedApp.update({ where: { id: req.params.id }, data: { active: false, revokedAt: new Date(), revokedById: req.user.id } });
    await oauth.endAppGrants(prisma, updated.id);
    res.json({ message: 'App access revoked', app: present(updated) });
  } catch (err) { next(err); }
});

// Refresh app token
// Any signed-in user could do this before, and the token was stored in the
// clear. It now takes the same admin rights as revoking the app.
router.post('/:id/refresh-token', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const newToken = crypto.randomBytes(32).toString('hex');
    const apiTokenHash = crypto.createHash('sha256').update(newToken).digest('hex');
    await prisma.connectedApp.update({ where: { id: req.params.id }, data: { apiTokenHash, tokenRefreshedAt: new Date() } });
    res.json({ message: 'Token refreshed', token: newToken });
  } catch (err) { next(err); }
});

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'connectedApps', model: 'connectedApp' });

// App usage analytics
router.get('/:id/analytics', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.connectedApp.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const apiCalls = await prisma.auditLog.count({ where: { module: 'connectedApps', recordId: req.params.id, createdAt: { gte: thirtyDays } } });
    const errors = await prisma.auditLog.count({ where: { module: 'connectedApps', recordId: req.params.id, action: 'error', createdAt: { gte: thirtyDays } } });
    const lastEvent = await prisma.connectedAppLog.findFirst({ where: { connectedAppId: app.id }, orderBy: { createdAt: 'desc' } });
    res.json({
      appId: app.id, name: app.name, apiCallsLast30d: apiCalls, errorsLast30d: errors,
      errorRate: apiCalls > 0 ? ((errors / apiCalls) * 100).toFixed(2) + '%' : '0%',
      status: app.active && !app.revokedAt ? 'active' : 'inactive',
      lastUsed: lastEvent?.createdAt || null,
    });
  } catch (err) { next(err); }
});

// Rotate client secret. The new one is shown once; only its hash is kept.
router.post('/:id/rotate-secret', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const clientSecret = oauth.newClientSecret();
    const rotatedAt = new Date();
    const app = await prisma.connectedApp.update({ where: { id: req.params.id }, data: { clientSecretHash: oauth.digest(clientSecret), secretRotatedAt: rotatedAt } });
    await req.audit({ action: 'update', module: 'connectedApps', recordId: app.id, details: 'Client secret rotated' });
    res.json({ id: app.id, clientSecret, rotatedAt });
  } catch (err) { next(err); }
});

// Test app connection: whether a user could authorize the app right now.
router.post('/:id/test', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.connectedApp.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    const checks = {
      active: app.active && !app.revokedAt,
      redirectUris: app.redirectUris.some(oauth.validRedirectUri),
      scopes: app.scopes.some(s => oauth.SCOPES[s]),
    };
    res.json({ appId: app.id, healthy: Object.values(checks).every(Boolean), checks, testedAt: new Date() });
  } catch (err) { next(err); }
});

module.exports = router;
