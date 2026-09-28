const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { pickModelFields, looksLikeId } = require('../utils/modelFields');
const { statusRoutes, summaryRoute } = require('../utils/moduleStatus');

const router = Router();

// `/count` was declared after `/:id`, which swallowed it.
const idParam = (req, res, next) => (looksLikeId('customComponent', req.params.id) ? next() : next('route'));

router.get('/', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const comps = await prisma.customComponent.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }); res.json(comps); } catch (err) { next(err); }
});

router.get('/:id', authenticate, idParam, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const c = await prisma.customComponent.findUnique({ where: { id: req.params.id } }); if (!c) return res.status(404).json({ error: 'Not found' }); res.json(c); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, label, type, markup, script, styles, style, description, targetModules, properties } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const comp = await prisma.customComponent.create({
      // label and markup are required columns; a new component starts empty.
      data: { name, label: label || name, type, markup: markup ?? '', script, style: style ?? styles, description, targetModules: targetModules || [], properties: properties || {}, version: '1.0.0', active: false, createdById: req.user.id },
    });
    res.status(201).json(comp);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, idParam, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdById, createdAt, updatedAt, deletedAt, styles, ...body } = req.body;
    const { data } = pickModelFields('customComponent', { ...body, ...(styles !== undefined && body.style === undefined && { style: styles }) });
    const c = await prisma.customComponent.update({ where: { id: req.params.id }, data });
    res.json(c);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, idParam, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.customComponent.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Bulk activate/deactivate. Before /:id/activate, which took `bulk` for an id.
router.post('/bulk/activate', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, active } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });
    const result = await prisma.customComponent.updateMany({ where: { id: { in: ids } }, data: { active: active !== false } });
    res.json({ updated: result.count });
  } catch (err) { next(err); }
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
    const versions = await prisma.customComponentVersion.findMany({ where: { customComponentId: req.params.id }, orderBy: { version: 'desc' }, take: 10 });
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

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'customComponents', model: 'customComponent' });

// Component usage analytics
router.get('/analytics/usage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Nothing records where a component is used, so there is no usage to
    // rank; this reported a usageCount column that was never there.
    const components = await prisma.customComponent.findMany({ where: { deletedAt: null }, select: { id: true, active: true, type: true } });
    const byType = components.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {});
    res.json({ total: components.length, active: components.filter(c => c.active).length, byType });
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

// Totals from the module's own table.
summaryRoute(router, { module: 'customComponents', model: 'customComponent' });
