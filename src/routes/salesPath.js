const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes } = require('../utils/modelFields');

const router = Router();

// List sales paths
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const paths = await prisma.salesPath.findMany({ where: { deletedAt: null }, orderBy: { module: 'asc' } });
    res.json(paths);
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: req.params.id }, include: { stages: { orderBy: { order: 'asc' } } } });
    if (!path) return res.status(404).json({ error: 'Sales path not found' });
    res.json(path);
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, stages } = req.body;
    if (!name || !module) return res.status(400).json({ error: 'name and module required' });
    const path = await queryWithIncludes(prisma, 'salesPath', 'create', {
      data: {
        name, module, active: true, createdById: req.user.id,
        ...(stages?.length && {
          stages: { create: stages.map((s, i) => ({ name: s.name, guidance: s.guidance || '', fields: s.fields || [], successCriteria: s.successCriteria || '', order: i + 1 })) },
        }),
      },
      include: { stages: true },
    });
    res.status(201).json(path);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const path = await prisma.salesPath.update({ where: { id: req.params.id }, data: req.body }); res.json(path); } catch (err) { next(err); }
});

// Get guidance for current stage
router.get('/:module/current/:stage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const path = await queryWithIncludes(prisma, 'salesPath', 'findFirst', {
      where: { module: req.params.module, active: true, deletedAt: null },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (!path) return res.json({ guidance: null });
    const currentStage = path.stages.find(s => s.name === req.params.stage);
    const currentIndex = path.stages.findIndex(s => s.name === req.params.stage);
    const nextStage = currentIndex >= 0 ? path.stages[currentIndex + 1] : null;
    res.json({
      salesPathId: path.id, currentStage: currentStage || null,
      nextStage: nextStage ? { name: nextStage.name, guidance: nextStage.guidance } : null,
      progress: path.stages.length ? Math.round(((currentIndex + 1) / path.stages.length) * 100) : 0,
      totalStages: path.stages.length,
    });
  } catch (err) { next(err); }
});

// Add/update stage
router.post('/:id/stages', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, guidance, fields, successCriteria, order } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const maxOrder = await prisma.salesPathStage.aggregate({ where: { salesPathId: req.params.id }, _max: { order: true } });
    const stage = await prisma.salesPathStage.create({
      data: { salesPathId: req.params.id, name, guidance, fields: fields || [], successCriteria, position: order || (maxOrder._max.order || 0) + 1 },
    });
    res.status(201).json(stage);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.salesPath.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

module.exports = router;

// Get full path with completion data for a deal
router.get('/:pathId/deal/:dealId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: req.params.pathId }, include: { stages: { orderBy: { order: 'asc' } } } });
    if (!path) return res.status(404).json({ error: 'Path not found' });
    const deal = await prisma.deal.findUnique({ where: { id: req.params.dealId } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const currentIdx = path.stages.findIndex(s => s.name === deal.stage);
    const stagesWithStatus = path.stages.map((s, i) => ({
      ...s, status: i < currentIdx ? 'completed' : i === currentIdx ? 'current' : 'upcoming',
      isCurrent: i === currentIdx, isCompleted: i < currentIdx,
    }));
    res.json({ path, deal: { id: deal.id, name: deal.name, stage: deal.stage, value: deal.value }, currentStageIndex: currentIdx, totalStages: path.stages.length, progressPercent: path.stages.length ? Math.round(((currentIdx + 1) / path.stages.length) * 100) : 0, stages: stagesWithStatus });
  } catch (err) { next(err); }
});

// Coaching content per stage
router.post('/:pathId/stages/:stageId/coaching', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { tips, requiredFields, keyActions, successCriteria } = req.body;
    const stage = await prisma.salesPathStage.update({ where: { id: req.params.stageId }, data: { coachingTips: tips, requiredFields: requiredFields || [], keyActions: keyActions || [], successCriteria: successCriteria || [] } });
    res.json(stage);
  } catch (err) { next(err); }
});

// Path analytics
router.get('/:id/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: req.params.id }, include: { stages: { orderBy: { order: 'asc' } } } });
    if (!path) return res.status(404).json({ error: 'Not found' });
    const stageNames = path.stages.map(s => s.name);
    const stageStats = [];
    for (const stageName of stageNames) {
      const [count, won, lost] = await Promise.all([
        prisma.deal.count({ where: { stage: stageName, deletedAt: null } }),
        prisma.deal.count({ where: { stage: 'Closed Won', deletedAt: null } }),
        prisma.deal.count({ where: { stage: 'Closed Lost', deletedAt: null } }),
      ]);
      const history = await prisma.dealStageHistory.findMany({ where: { stage: stageName }, select: { daysInStage: true } });
      const avgDays = history.length ? history.reduce((s, h) => s + (h.daysInStage || 0), 0) / history.length : 0;
      stageStats.push({ stage: stageName, activeDeals: count, avgDaysInStage: Math.round(avgDays * 10) / 10 });
    }
    res.json({ pathId: path.id, pathName: path.name, stages: stageStats, totalActiveDeals: stageStats.reduce((s, st) => s + st.activeDeals, 0) });
  } catch (err) { next(err); }
});

// Reorder stages
router.put('/:id/reorder', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { stageIds } = req.body;
    if (!stageIds?.length) return res.status(400).json({ error: 'stageIds array required' });
    for (let i = 0; i < stageIds.length; i++) {
      await prisma.salesPathStage.update({ where: { id: stageIds[i] }, data: { position: i } });
    }
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: req.params.id }, include: { stages: { orderBy: { order: 'asc' } } } });
    res.json(path);
  } catch (err) { next(err); }
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'SalesPath';
    // Generic stats endpoint
    const stats = {
      module: 'salesPath',
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
      try { return await prisma.$executeRaw`UPDATE "salesPath" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'salesPath', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
