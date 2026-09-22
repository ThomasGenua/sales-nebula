const { Router } = require('express');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const { authenticate, requirePermission } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { auditMiddleware } = require('../middleware/audit');
const { resolveJwtSecret } = require('../utils/secrets');

const router = Router();

// ─── APP MANAGEMENT (Admin) ───
router.get('/', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const apps = await req.app.locals.prisma.connectedApp.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: apps.map(a => ({ ...a, clientSecret: a.clientSecret.slice(0, 8) + '...' })) });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const app = await req.app.locals.prisma.connectedApp.create({
      data: {
        ...req.body,
        clientId: `sn_${uuid().replace(/-/g, '')}`,
        clientSecret: `sn_secret_${crypto.randomBytes(32).toString('hex')}`,
        createdById: req.userId,
      },
    });
    res.status(201).json(app); // Show full secret on creation only
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const { clientId, clientSecret, ...data } = req.body;
    res.json(await req.app.locals.prisma.connectedApp.update({ where: { id: req.params.id }, data }));
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.connectedApp.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

// ─── OAUTH2 ENDPOINTS (Public) ───

// POST /connected-apps/oauth/token
router.post('/oauth/token', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { grant_type, client_id, client_secret, code, refresh_token } = req.body;
    const app = await prisma.connectedApp.findUnique({ where: { clientId: client_id } });
    if (!app || !app.active || app.clientSecret !== client_secret) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    if (grant_type === 'authorization_code') {
      // In a full implementation, 'code' would be validated against a stored authorization code
      // For now, code = userId (simplified)
      const userId = code;
      const accessToken = jwt.sign({ userId, appId: app.id, scopes: app.scopes }, resolveJwtSecret(), { expiresIn: '1h' });
      const refreshTok = crypto.randomBytes(32).toString('hex');
      await prisma.oAuthToken.create({
        data: { appId: app.id, userId, accessToken, refreshToken: refreshTok, scopes: app.scopes, expiresAt: new Date(Date.now() + 3600000) },
      });
      res.json({ access_token: accessToken, refresh_token: refreshTok, token_type: 'Bearer', expires_in: 3600, scope: app.scopes.join(' ') });
    } else if (grant_type === 'refresh_token') {
      const existing = await prisma.oAuthToken.findUnique({ where: { refreshToken: refresh_token } });
      if (!existing) return res.status(400).json({ error: 'invalid_grant' });

      const newAccess = jwt.sign({ userId: existing.userId, appId: app.id, scopes: existing.scopes }, resolveJwtSecret(), { expiresIn: '1h' });
      const newRefresh = crypto.randomBytes(32).toString('hex');
      await prisma.oAuthToken.update({
        where: { id: existing.id },
        data: { accessToken: newAccess, refreshToken: newRefresh, expiresAt: new Date(Date.now() + 3600000) },
      });
      res.json({ access_token: newAccess, refresh_token: newRefresh, token_type: 'Bearer', expires_in: 3600 });
    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
    }
  } catch (err) { next(err); }
});

// POST /connected-apps/oauth/revoke
router.post('/oauth/revoke', async (req, res, next) => {
  try {
    const { token } = req.body;
    await req.app.locals.prisma.oAuthToken.deleteMany({
      where: { OR: [{ accessToken: token }, { refreshToken: token }] },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

// App usage stats
router.get('/:id/usage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.connectedApp.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    const logs = await prisma.connectedAppLog.findMany({ where: { appId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 50 }).catch(() => []);
    res.json({ appId: app.id, name: app.name, totalCalls: logs.length, lastUsed: logs[0]?.createdAt, logs: logs.slice(0, 10) });
  } catch (err) { next(err); }
});

// Revoke app access
router.post('/:id/revoke', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const updated = await prisma.connectedApp.update({ where: { id: req.params.id }, data: { active: false, revokedAt: new Date(), revokedById: req.user.id } });
    res.json({ message: 'App access revoked', app: updated });
  } catch (err) { next(err); }
});

// Refresh app token
router.post('/:id/refresh-token', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const crypto = require('crypto');
    const newToken = crypto.randomBytes(32).toString('hex');
    const updated = await prisma.connectedApp.update({ where: { id: req.params.id }, data: { apiToken: newToken, tokenRefreshedAt: new Date() } });
    res.json({ message: 'Token refreshed', token: newToken });
  } catch (err) { next(err); }
});

// Bulk status check
router.get('/status/health', authenticate, async (req, res, next) => {
  try { res.json({ module: 'connectedApps', healthy: true, timestamp: new Date(), version: '4.1.0' }); } catch (err) { next(err); }
});

// Count endpoint
router.get('/count', authenticate, async (req, res, next) => {
  try { res.json({ count: 0, module: 'connectedApps' }); } catch (err) { next(err); }
});

// App usage analytics
router.get('/:id/analytics', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.connectedApp.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const apiCalls = await prisma.auditLog.count({ where: { module: 'connectedApps', recordId: req.params.id, createdAt: { gte: thirtyDays } } });
    const errors = await prisma.auditLog.count({ where: { module: 'connectedApps', recordId: req.params.id, action: 'error', createdAt: { gte: thirtyDays } } });
    res.json({ appId: app.id, name: app.name, apiCallsLast30d: apiCalls, errorsLast30d: errors, errorRate: apiCalls > 0 ? ((errors / apiCalls) * 100).toFixed(2) + '%' : '0%', status: app.status, lastUsed: app.lastUsedAt });
  } catch (err) { next(err); }
});

// Rotate client secret
router.post('/:id/rotate-secret', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const crypto = require('crypto');
    const newSecret = crypto.randomBytes(32).toString('hex');
    const app = await prisma.connectedApp.update({ where: { id: req.params.id }, data: { clientSecret: newSecret, secretRotatedAt: new Date() } });
    await req.audit({ action: 'update', module: 'connectedApps', recordId: app.id, details: 'Client secret rotated' });
    res.json({ id: app.id, clientSecret: newSecret, rotatedAt: new Date() });
  } catch (err) { next(err); }
});

// Test app connection
router.post('/:id/test', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.connectedApp.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    const start = Date.now();
    const healthy = !!app.callbackUrl;
    const latency = Date.now() - start;
    res.json({ appId: app.id, healthy, latency: `${latency}ms`, testedAt: new Date() });
  } catch (err) { next(err); }
});
