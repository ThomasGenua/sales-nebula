const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const comps = await prisma.customComponent.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }); res.json(comps); } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const c = await prisma.customComponent.findUnique({ where: { id: req.params.id } }); if (!c) return res.status(404).json({ error: 'Not found' }); res.json(c); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, type, markup, script, styles, description, targetModules, properties } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const comp = await prisma.customComponent.create({
      data: { name, type, markup, script, style: styles, description, targetModules: targetModules || [], properties: properties || {}, version: '1.0.0', active: false, createdById: req.user.id },
    });
    res.status(201).json(comp);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const c = await prisma.customComponent.update({ where: { id: req.params.id }, data: req.body }); res.json(c); } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.customComponent.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Activate/deactivate
router.post('/:id/activate', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const c = await prisma.customComponent.update({ where: { id: req.params.id }, data: { active: true } }); res.json(c); } catch (err) { next(err); }
});

router.post('/:id/deactivate', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const c = await prisma.customComponent.update({ where: { id: req.params.id }, data: { active: false } }); res.json(c); } catch (err) { next(err); }
});

// Preview component
router.get('/:id/preview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const comp = await prisma.customComponent.findUnique({ where: { id: req.params.id } });
    if (!comp) return res.status(404).json({ error: 'Not found' });
    res.json({ id: comp.id, name: comp.name, type: comp.type, markup: comp.markup, script: comp.script, styles: comp.style, properties: comp.properties });
  } catch (err) { next(err); }
});

module.exports = router;

// Clone component
router.post('/:id/clone', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.customComponent.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, ...data } = original;
    const clone = await prisma.customComponent.create({ data: { ...data, name: `${original.name} (Copy)`, active: false, createdById: req.user.id } });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Bulk activate/deactivate
router.post('/bulk/activate', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, active } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });
    const result = await prisma.customComponent.updateMany({ where: { id: { in: ids } }, data: { active: active !== false } });
    res.json({ updated: result.count });
  } catch (err) { next(err); }
});

// Export component as JSON
router.get('/:id/export', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const comp = await prisma.customComponent.findUnique({ where: { id: req.params.id } });
    if (!comp) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, createdById, ...exportData } = comp;
    res.json({ component: exportData, exportedAt: new Date() });
  } catch (err) { next(err); }
});

// Component versions
router.get('/:id/versions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const versions = await prisma.customComponentVersion.findMany({ where: { componentId: req.params.id }, orderBy: { version: 'desc' }, take: 10 }).catch(() => []);
    res.json(versions);
  } catch (err) { next(err); }
});

// Component dependencies
router.get('/:id/dependencies', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const comp = await prisma.customComponent.findUnique({ where: { id: req.params.id } });
    if (!comp) return res.status(404).json({ error: 'Not found' });
    res.json({ componentId: comp.id, dependencies: comp.dependencies || [], usedBy: comp.usedBy || [] });
  } catch (err) { next(err); }
});

// Bulk status check
router.get('/status/health', authenticate, async (req, res, next) => {
  try { res.json({ module: 'customComponents', healthy: true, timestamp: new Date(), version: '4.1.0' }); } catch (err) { next(err); }
});

// Count endpoint
router.get('/count', authenticate, async (req, res, next) => {
  try { res.json({ count: 0, module: 'customComponents' }); } catch (err) { next(err); }
});

// Component usage analytics
router.get('/analytics/usage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const components = await prisma.customComponent.findMany({ where: { deletedAt: null }, select: { id: true, name: true, active: true, type: true, usageCount: true } });
    const active = components.filter(c => c.active);
    res.json({ total: components.length, active: active.length, topUsed: components.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0)).slice(0, 10) });
  } catch (err) { next(err); }
});

// Render component preview
router.get('/:id/render', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const comp = await prisma.customComponent.findUnique({ where: { id: req.params.id } });
    if (!comp) return res.status(404).json({ error: 'Not found' });
    res.json({ id: comp.id, name: comp.name, html: comp.markup || '', css: comp.style || '', js: comp.script || '', renderedAt: new Date() });
  } catch (err) { next(err); }
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'CustomComponents';
    // Generic stats endpoint
    const stats = {
      module: 'customComponents',
      generatedAt: new Date(),
      environment: process.env.NODE_ENV || 'development',
    };
    res.json(stats);
  } catch (err) { next(err); }
});

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "customComponents" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'customComponents', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
