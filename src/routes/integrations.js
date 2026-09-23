const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const { pickModelFields } = require('../utils/modelFields');

const router = Router();

/*
 * Integrations hold third-party credentials. Listing or fetching one took a
 * session alone and returned the row whole, `credentials` included; the
 * schedule and field mappings could be changed by anyone. Reading now takes
 * admin: read and never returns credentials or secret-looking config values;
 * changing takes admin: edit.
 */
const SECRET_KEY = /secret|token|password|passwd|api[-_]?key|private/i;
function present(integration) {
  if (!integration) return integration;
  const { credentials, ...rest } = integration;
  if (rest.config && typeof rest.config === 'object' && !Array.isArray(rest.config)) {
    rest.config = Object.fromEntries(Object.entries(rest.config).map(([k, v]) => [k, SECRET_KEY.test(k) && v ? '••••••' : v]));
  }
  return { ...rest, hasCredentials: credentials != null };
}

router.get('/', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const integrations = await prisma.integration.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
    res.json(integrations.map(present));
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const i = await prisma.integration.findUnique({ where: { id: req.params.id } }); if (!i) return res.status(404).json({ error: 'Not found' }); res.json(present(i)); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, type, config, description } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const integration = await prisma.integration.create({
      data: { name, type, config: config || {}, description, status: 'Active', createdById: req.user.id },
    });
    res.status(201).json(present(integration));
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const { id, createdAt, updatedAt, createdById, ...rest } = req.body || {}; const i = await prisma.integration.update({ where: { id: req.params.id }, data: pickModelFields('integration', rest).data }); res.json(present(i)); } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.integration.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Trigger sync
router.post('/:id/sync', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) return res.status(404).json({ error: 'Not found' });
    // No integration type has a sync connector. This used to log the run,
    // then mark it Completed three seconds later with a random record count
    // and stamp lastSyncAt, reporting a sync that never happened. Record the
    // attempt and say plainly that nothing was synced.
    const error = `No sync connector is implemented for ${integration.provider || integration.type || 'this integration'}`;
    const now = new Date();
    const syncLog = await prisma.syncLog.create({
      data: {
        integrationId: req.params.id, direction: req.body.direction || 'inbound',
        status: 'Failed', startedAt: now, completedAt: now,
        errors: [{ message: error }], triggeredById: req.user.id,
      },
    });
    res.status(501).json({ syncId: syncLog.id, status: 'Failed', error });
  } catch (err) { next(err); }
});

// Sync logs
router.get('/:id/logs', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const logs = await prisma.syncLog.findMany({
      where: { integrationId: req.params.id },
      orderBy: { startedAt: 'desc' }, take: 50,
    });
    res.json(logs);
  } catch (err) { next(err); }
});

// Test connection
router.post('/:id/test', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) return res.status(404).json({ error: 'Not found' });
    // This always answered "passed" with a random latency, whatever the
    // credentials. There is no connector to test against, so say so.
    res.status(501).json({ success: false, error: `No connection test is implemented for ${integration.provider || integration.type || 'this integration'}` });
  } catch (err) { next(err); }
});

// Email sync status
router.get('/email-sync', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const emailIntegrations = await prisma.integration.findMany({ where: { type: { in: ['gmail', 'outlook', 'email'] }, deletedAt: null } });
    res.json(emailIntegrations.map(i => ({ id: i.id, name: i.name, type: i.type, status: i.status, lastSync: i.lastSyncAt })));
  } catch (err) { next(err); }
});

module.exports = router;

// Sync schedule
router.get('/:id/schedule', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) return res.status(404).json({ error: 'Not found' });
    res.json({ integrationId: integration.id, syncFrequency: integration.syncFrequency || 'manual', lastSync: integration.lastSyncAt, nextSync: integration.nextSyncAt, syncEnabled: integration.syncEnabled !== false });
  } catch (err) { next(err); }
});

router.put('/:id/schedule', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { syncFrequency, syncEnabled } = req.body;
    const updated = await prisma.integration.update({ where: { id: req.params.id }, data: { syncFrequency, syncEnabled, nextSyncAt: syncEnabled ? new Date(Date.now() + 3600000) : null } });
    res.json(present(updated));
  } catch (err) { next(err); }
});

// Field mapping
router.get('/:id/mappings', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const mappings = await prisma.integrationFieldMapping.findMany({ where: { integrationId: req.params.id } }).catch(() => []);
    res.json(mappings);
  } catch (err) { next(err); }
});

router.put('/:id/mappings', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { mappings } = req.body;
    if (!mappings?.length) return res.status(400).json({ error: 'mappings required' });
    await prisma.integrationFieldMapping.deleteMany({ where: { integrationId: req.params.id } });
    const created = await Promise.all(mappings.map(m => prisma.integrationFieldMapping.create({ data: { integrationId: req.params.id, sourceField: m.sourceField, targetField: m.targetField, direction: m.direction || 'bidirectional' } })));
    res.json(created);
  } catch (err) { next(err); }
});

// Integration health check
router.get('/:id/health', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const int = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!int) return res.status(404).json({ error: 'Not found' });
    const recentLogs = await prisma.syncLog.findMany({ where: { integrationId: req.params.id }, orderBy: { startedAt: 'desc' }, take: 10 });
    const errorCount = recentLogs.filter(l => ['error', 'Failed'].includes(l.status)).length;
    res.json({ status: errorCount > 3 ? 'unhealthy' : errorCount > 0 ? 'degraded' : 'healthy', recentErrors: errorCount, lastSync: int.lastSyncAt, recentLogs: recentLogs.slice(0, 5) });
  } catch (err) { next(err); }
});

// Integration health dashboard
router.get('/health', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const integrations = await prisma.integration.findMany({ where: { deletedAt: null } });
    const health = [];
    for (const int of integrations) {
      const logs = await prisma.syncLog.findMany({ where: { integrationId: int.id }, orderBy: { startedAt: 'desc' }, take: 10 });
      const successRate = logs.length > 0 ? (logs.filter(l => l.status === 'Success').length / logs.length * 100).toFixed(0) + '%' : 'N/A';
      health.push({ id: int.id, name: int.name, provider: int.provider, status: int.status, lastSync: int.lastSyncAt, recentLogs: logs.length, successRate });
    }
    res.json(health);
  } catch (err) { next(err); }
});
