const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { statusRoutes, summaryRoute } = require('../utils/moduleStatus');
const { looksLikeId, columnsFrom } = require('../utils/modelFields');

const router = Router();

// A segment that is not an id (`/count`) falls through to the routes below.
const idParam = (req, res, next) => (looksLikeId('customCode', req.params.id) ? next() : next('route'));

router.get('/', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const scripts = await prisma.customCode.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }); res.json(scripts); } catch (err) { next(err); }
});

router.get('/:id', authenticate, idParam, requirePermission('admin', 'read'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const s = await prisma.customCode.findUnique({ where: { id: req.params.id } }); if (!s) return res.status(404).json({ error: 'Not found' }); res.json(s); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, language, code, triggerModule, triggerEvent, description } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'name and code required' });
    // Version 1 to start from: PUT increments it, and an increment of a null
    // column stays null, so no script ever had a version.
    const script = await prisma.customCode.create({
      data: { name, language: language || 'javascript', code, module: triggerModule, triggerEvent, description, active: false, version: 1, createdById: req.user.id },
    });
    res.status(201).json(script);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, idParam, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const script = await prisma.customCode.update({ where: { id: req.params.id }, data: { ...columnsFrom('customCode', req.body), version: { increment: 1 } } });
    res.json(script);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, idParam, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.customCode.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Activate/deactivate
router.post('/:id/activate', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const script = await prisma.customCode.update({ where: { id: req.params.id }, data: { active: true } });
    await req.audit({ action: 'update', module: 'customCode', recordId: script.id, details: 'Activated' });
    res.json(script);
  } catch (err) { next(err); }
});

router.post('/:id/deactivate', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const s = await prisma.customCode.update({ where: { id: req.params.id }, data: { active: false } }); res.json(s); } catch (err) { next(err); }
});

// Test execute (sandbox)
router.post('/:id/test', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const script = await prisma.customCode.findUnique({ where: { id: req.params.id } });
    if (!script) return res.status(404).json({ error: 'Not found' });
    const startTime = Date.now();
    // Sandboxed execution would go here; for safety, just validate syntax
    try { new Function(script.code); res.json({ success: true, executionTime: Date.now() - startTime, message: 'Syntax validation passed' }); }
    catch (e) { res.json({ success: false, error: e.message, message: 'Syntax error' }); }
  } catch (err) { next(err); }
});

// Execution logs
router.get('/:id/logs', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const logs = await prisma.customCodeLog.findMany({ where: { customCodeId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json(logs);
  } catch (err) { next(err); }
});

module.exports = router;

// Versioning
router.get('/:id/versions', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const versions = await prisma.customCodeVersion.findMany({
      where: { customCodeId: req.params.id }, orderBy: { version: 'desc' }, take: 20,
    });
    res.json(versions);
  } catch (err) { next(err); }
});

// Clone script
router.post('/:id/clone', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.customCode.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, ...data } = original;
    const clone = await prisma.customCode.create({ data: { ...data, name: `${original.name} (Copy)`, active: false, createdById: req.user.id } });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Execution stats
router.get('/:id/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const logs = await prisma.customCodeExecution.findMany({ where: { customCodeId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 50 }).catch(() => []);
    const successful = logs.filter(l => l.status === 'success');
    res.json({ executions: logs.length, successRate: logs.length ? Math.round(successful.length / logs.length * 100) : 0, avgDuration: logs.length ? Math.round(logs.reduce((s, l) => s + (l.duration || 0), 0) / logs.length) : 0, recentLogs: logs.slice(0, 10) });
  } catch (err) { next(err); }
});

// Schedule execution
router.post('/:id/schedule', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { cron, enabled } = req.body;
    const updated = await prisma.customCode.update({ where: { id: req.params.id }, data: { schedule: cron, scheduleEnabled: enabled !== false } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Dependencies
// Read from the script's `code`; `source` is not a column, so this always
// reported none. What it reads is the code, so it takes admin: read like /:id.
router.get('/:id/dependencies', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const code = await prisma.customCode.findUnique({ where: { id: req.params.id } });
    if (!code) return res.status(404).json({ error: 'Not found' });
    const deps = (code.code || '').match(/require\(['"]([^'"]+)['"]\)/g) || [];
    res.json({ id: code.id, dependencies: deps.map(d => d.replace(/require\(['"]|['"]\)/g, '')), sourceLength: (code.code || '').length });
  } catch (err) { next(err); }
});

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'customCode', model: 'customCode' });

// Totals from the module's own table.
summaryRoute(router, { module: 'customCode', model: 'customCode' });
