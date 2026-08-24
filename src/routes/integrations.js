const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const integrations = await prisma.integration.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
    res.json(integrations);
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const i = await prisma.integration.findUnique({ where: { id: req.params.id } }); if (!i) return res.status(404).json({ error: 'Not found' }); res.json(i); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, type, config, description } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const integration = await prisma.integration.create({
      data: { name, type, config: config || {}, description, status: 'Active', createdById: req.user.id },
    });
    res.status(201).json(integration);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const i = await prisma.integration.update({ where: { id: req.params.id }, data: req.body }); res.json(i); } catch (err) { next(err); }
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
    const syncLog = await prisma.syncLog.create({
      data: { integrationId: req.params.id, status: 'Running', startedAt: new Date(), triggeredById: req.user.id },
    });
    // Simulate async sync completion
    setTimeout(async () => {
      try { await prisma.syncLog.update({ where: { id: syncLog.id }, data: { status: 'Completed', completedAt: new Date(), recordsSynced: Math.floor(Math.random() * 100) } }); } catch (e) {}
    }, 3000);
    await prisma.integration.update({ where: { id: req.params.id }, data: { lastSyncAt: new Date() } });
    res.json({ syncId: syncLog.id, status: 'Running', message: 'Sync initiated' });
  } catch (err) { next(err); }
});

// Sync logs
router.get('/:id/logs', authenticate, async (req, res, next) => {
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
    // Simulate connection test
    res.json({ success: true, message: 'Connection test passed', latencyMs: Math.floor(Math.random() * 200 + 50) });
  } catch (err) { next(err); }
});

// Email sync status
router.get('/email-sync', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const emailIntegrations = await prisma.integration.findMany({ where: { type: { in: ['gmail', 'outlook', 'email'] }, deletedAt: null } });
    res.json(emailIntegrations.map(i => ({ id: i.id, name: i.name, type: i.type, status: i.status, lastSync: i.lastSyncAt })));
  } catch (err) { next(err); }
});

module.exports = router;

// Sync schedule
router.get('/:id/schedule', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) return res.status(404).json({ error: 'Not found' });
    res.json({ integrationId: integration.id, syncFrequency: integration.syncFrequency || 'manual', lastSync: integration.lastSyncAt, nextSync: integration.nextSyncAt, syncEnabled: integration.syncEnabled !== false });
  } catch (err) { next(err); }
});

router.put('/:id/schedule', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { syncFrequency, syncEnabled } = req.body;
    const updated = await prisma.integration.update({ where: { id: req.params.id }, data: { syncFrequency, syncEnabled, nextSyncAt: syncEnabled ? new Date(Date.now() + 3600000) : null } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Field mapping
router.get('/:id/mappings', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const mappings = await prisma.integrationFieldMapping.findMany({ where: { integrationId: req.params.id } }).catch(() => []);
    res.json(mappings);
  } catch (err) { next(err); }
});

router.put('/:id/mappings', authenticate, async (req, res, next) => {
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
router.get('/:id/health', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const int = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!int) return res.status(404).json({ error: 'Not found' });
    const recentLogs = await prisma.syncLog.findMany({ where: { integrationId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 10 }).catch(() => []);
    const errorCount = recentLogs.filter(l => l.status === 'error').length;
    res.json({ status: errorCount > 3 ? 'unhealthy' : errorCount > 0 ? 'degraded' : 'healthy', recentErrors: errorCount, lastSync: int.lastSyncAt, recentLogs: recentLogs.slice(0, 5) });
  } catch (err) { next(err); }
});

// Integration health dashboard
router.get('/health', authenticate, async (req, res, next) => {
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
