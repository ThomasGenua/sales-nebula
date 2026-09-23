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
    res.json({ data: apps.map(({ apiTokenHash, ...a }) => ({ ...a, clientSecret: a.clientSecret.slice(0, 8) + '...' })) });
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
    const { client_id, client_secret } = req.body;
    const app = await prisma.connectedApp.findUnique({ where: { clientId: client_id } });
    if (!app || !app.active || app.clientSecret !== client_secret) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    // There is no authorization endpoint, so there are no authorization codes:
    // this took `code` to be a user id and signed a session-strength token for
    // whichever user it named. Holding one app's client secret was enough to
    // become any user, administrators included. Until a consent step exists
    // that issues real codes, no grant is honoured.
    return res.status(501).json({
      error: 'unsupported_grant_type',
      error_description: 'Connected-app OAuth has no authorization step yet, so it issues no tokens',
    });
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
    const logs = await prisma.connectedAppLog.findMany({ where: { connectedAppId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 50 });
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
// Any signed-in user could do this before, and the token was stored in the
// clear. It now takes the same admin rights as revoking the app.
router.post('/:id/refresh-token', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const crypto = require('crypto');
    const newToken = crypto.randomBytes(32).toString('hex');
    const apiTokenHash = crypto.createHash('sha256').update(newToken).digest('hex');
    await prisma.connectedApp.update({ where: { id: req.params.id }, data: { apiTokenHash, tokenRefreshedAt: new Date() } });
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
