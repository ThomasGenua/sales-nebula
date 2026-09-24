const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { queryWithIncludes, pickModelFields } = require('../utils/modelFields');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();

// A path's module -> its permission module, model, and the column a record's
// stage is kept in.
const PATH_MODULES = {
  deals: ['deals', 'deal', 'stage'],
  leads: ['leads', 'lead', 'status'],
  cases: ['cases', 'case', 'status'],
};

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
    // A live path, as the list shows: a deleted one still opened here.
    const path = await queryWithIncludes(prisma, 'salesPath', 'findFirst', { where: { id: req.params.id, deletedAt: null }, include: { stages: { orderBy: { position: 'asc' } } } });
    if (!path) return res.status(404).json({ error: 'Sales path not found' });
    res.json(path);
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, stages } = req.body;
    if (!name || !module) return res.status(400).json({ error: 'name and module required' });
    // A path declares no relation to its stages, so they cannot be created
    // nested inside it; that threw whenever stages were given.
    const created = await prisma.salesPath.create({ data: { name, module, active: true, createdById: req.user.id } });
    if (stages?.length) {
      await prisma.salesPathStage.createMany({
        data: stages.map((s, i) => ({ salesPathId: created.id, name: s.name, guidance: s.guidance || '', fields: s.fields || [], successCriteria: s.successCriteria ?? undefined, position: i + 1 })),
      });
    }
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: created.id }, include: { stages: true } });
    res.status(201).json(path);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdById, createdAt, updatedAt, deletedAt, stages, ...body } = req.body;
    const path = await prisma.salesPath.update({ where: { id: req.params.id }, data: pickModelFields('salesPath', body).data });
    res.json(path);
  } catch (err) { next(err); }
});

// Get guidance for current stage
router.get('/:module/current/:stage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const path = await queryWithIncludes(prisma, 'salesPath', 'findFirst', {
      where: { module: req.params.module, active: true, deletedAt: null },
      include: { stages: { orderBy: { position: 'asc' } } },
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
    const { name, guidance, fields, successCriteria } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    // On a live path: a stage has no relation to hold it to one, so any id
    // took a stage. Its position is a whole number; text was a 500.
    const path = await prisma.salesPath.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true } });
    if (!path) return res.status(404).json({ error: 'Sales path not found' });
    const last = await prisma.salesPathStage.aggregate({ where: { salesPathId: req.params.id }, _max: { position: true } });
    const stage = await prisma.salesPathStage.create({
      data: { salesPathId: req.params.id, name, guidance, fields: fields || [], successCriteria, position: parseInt(req.body.order) || (last._max.position || 0) + 1 },
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
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: req.params.pathId }, include: { stages: { orderBy: { position: 'asc' } } } });
    if (!path) return res.status(404).json({ error: 'Path not found' });
    // A deal the caller can see: any deal id answered with its name, stage
    // and value, to anyone signed in.
    const deal = permits(req, 'deals', 'read')
      && await prisma.deal.findFirst({ where: await reachableWhere(req, 'deals', 'deal', { id: String(req.params.dealId) }) });
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
    // A stage of the path in the URL: any path's stage went by id.
    const onPath = await prisma.salesPathStage.findFirst({ where: { id: req.params.stageId, salesPathId: req.params.pathId }, select: { id: true } });
    if (!onPath) return res.status(404).json({ error: 'Stage not found' });
    // A stage's coaching text is its guidance and its required fields are its
    // fields; only what the caller sends is changed.
    const stage = await prisma.salesPathStage.update({
      where: { id: req.params.stageId },
      data: {
        ...(tips !== undefined && { guidance: Array.isArray(tips) ? tips.join('\n') : tips }),
        ...(requiredFields !== undefined && { fields: requiredFields }),
        ...(keyActions !== undefined && { keyActions }),
        ...(successCriteria !== undefined && { successCriteria }),
      },
    });
    res.json(stage);
  } catch (err) { next(err); }
});

// Path analytics
router.get('/:id/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: req.params.id }, include: { stages: { orderBy: { position: 'asc' } } } });
    if (!path) return res.status(404).json({ error: 'Not found' });
    const stageNames = path.stages.map(s => s.name);
    // The path's own module's records in each stage (a lead's or case's stage
    // is its status), of those the caller may see: this counted every deal,
    // whatever the path, other reps' and deleted history included, and ran
    // won and lost counts it never used.
    const [module, model, field] = PATH_MODULES[path.module] || PATH_MODULES.deals;
    const readable = permits(req, module, 'read');
    const dealWhere = module === 'deals' && readable ? await reachableWhere(req, 'deals', 'deal') : null;
    const stageStats = [];
    for (const stageName of stageNames) {
      const count = readable ? await prisma[model].count({ where: await reachableWhere(req, module, model, { [field]: stageName }) }) : 0;
      // A history row's duration is the days the deal spent in fromStage.
      const history = dealWhere
        ? await prisma.dealStageHistory.findMany({ where: { fromStage: stageName, duration: { not: null }, deal: { is: dealWhere } }, select: { duration: true } })
        : [];
      const avgDays = history.length ? history.reduce((s, h) => s + h.duration, 0) / history.length : 0;
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
    if (!Array.isArray(stageIds) || !stageIds.length) return res.status(400).json({ error: 'stageIds array required' });
    // Only this path's stages: any stage id was moved, whatever its path.
    for (let i = 0; i < stageIds.length; i++) {
      await prisma.salesPathStage.updateMany({ where: { id: String(stageIds[i]), salesPathId: req.params.id }, data: { position: i } });
    }
    const path = await queryWithIncludes(prisma, 'salesPath', 'findUnique', { where: { id: req.params.id }, include: { stages: { orderBy: { position: 'asc' } } } });
    res.json(path);
  } catch (err) { next(err); }
});

// Totals from the module's own table.
summaryRoute(router, { module: 'salesPath', model: 'salesPath' });
