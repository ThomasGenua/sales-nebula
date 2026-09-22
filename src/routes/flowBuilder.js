const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes } = require('../utils/modelFields');
const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { module, status, type } = req.query;
    const where = {};
    if (module) where.module = module;
    if (status) where.status = status;
    if (type) where.type = type;
    const flows = await req.app.locals.prisma.flowDefinition.findMany({ where, orderBy: { updatedAt: 'desc' } });
    res.json({ data: flows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const flow = await req.app.locals.prisma.flowDefinition.findUnique({ where: { id: req.params.id }, include: { versions: { orderBy: { version: 'desc' }, take: 5 }, runs: { orderBy: { startedAt: 'desc' }, take: 10 } } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    res.json(flow);
  } catch (err) { next(err); }
});

router.post('/', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const flow = await req.app.locals.prisma.flowDefinition.create({
      data: { ...req.body, createdById: req.userId, canvas: req.body.canvas || { nodes: [], edges: [] } },
    });
    await req.app.locals.prisma.flowVersion.create({ data: { flowId: flow.id, version: 1, canvas: flow.canvas } });
    res.status(201).json(flow);
  } catch (err) { next(err); }
});

router.put('/:id', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const flow = await prisma.flowDefinition.update({ where: { id: req.params.id }, data: req.body });
    if (req.body.canvas) {
      const v = await prisma.flowVersion.findFirst({ where: { flowId: flow.id }, orderBy: { version: 'desc' } });
      await prisma.flowVersion.create({ data: { flowId: flow.id, version: (v?.version || 0) + 1, canvas: req.body.canvas } });
      await prisma.flowDefinition.update({ where: { id: flow.id }, data: { version: (v?.version || 0) + 1 } });
    }
    res.json(flow);
  } catch (err) { next(err); }
});

router.post('/:id/activate', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const flow = await req.app.locals.prisma.flowDefinition.update({ where: { id: req.params.id }, data: { status: 'Active' } });
    const v = await req.app.locals.prisma.flowVersion.findFirst({ where: { flowId: flow.id }, orderBy: { version: 'desc' } });
    if (v) await req.app.locals.prisma.flowVersion.update({ where: { id: v.id }, data: { publishedAt: new Date(), publishedById: req.userId } });
    res.json(flow);
  } catch (err) { next(err); }
});

router.post('/:id/run', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const flow = await prisma.flowDefinition.findUnique({ where: { id: req.params.id } });
    if (!flow || flow.status !== 'Active') return res.status(400).json({ error: 'Flow not active' });
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, triggerRecordId: req.body.recordId, triggerModule: req.body.module, context: req.body.context || {}, status: 'Running' },
    });
    // Execute flow nodes
    try {
      const canvas = flow.canvas;
      const log = [];
      for (const node of (canvas.nodes || [])) {
        log.push({ nodeId: node.id, type: node.type, status: 'executed', timestamp: new Date() });
      }
      await prisma.flowRun.update({ where: { id: run.id }, data: { status: 'Completed', completedAt: new Date(), log } });
    } catch (e) {
      await prisma.flowRun.update({ where: { id: run.id }, data: { status: 'Failed', error: e.message, completedAt: new Date() } });
    }
    const result = await prisma.flowRun.findUnique({ where: { id: run.id } });
    res.json(result);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.flowDefinition.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

module.exports = router;

// Flow execution history
router.get('/:id/executions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50 } = req.query;
    const [execs, total] = await Promise.all([
      prisma.flowExecution.findMany({ where: { flowDefinitionId: req.params.id }, orderBy: { startedAt: 'desc' }, skip: (+page - 1) * +limit, take: +limit }),
      prisma.flowExecution.count({ where: { flowDefinitionId: req.params.id } }),
    ]);
    res.json({ data: execs, total, page: +page });
  } catch (err) { next(err); }
});

// Debug/test flow
router.post('/:id/test', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const flow = await queryWithIncludes(prisma, 'flowDefinition', 'findUnique', { where: { id: req.params.id }, include: { elements: { orderBy: { order: 'asc' } } } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    const { testData } = req.body;
    const results = [];
    for (const el of flow.elements) {
      const result = { elementId: el.id, elementType: el.type, name: el.name, status: 'simulated' };
      if (el.type === 'Decision') { result.outcome = 'Default'; result.evaluatedConditions = el.config?.conditions?.length || 0; }
      else if (el.type === 'Assignment') { result.assignments = el.config?.assignments?.length || 0; }
      else if (el.type === 'RecordCreate') { result.recordType = el.config?.objectType; result.simulated = true; }
      else if (el.type === 'RecordUpdate') { result.recordType = el.config?.objectType; result.fieldsUpdated = Object.keys(el.config?.fields || {}).length; }
      results.push(result);
    }
    res.json({ flowId: flow.id, flowName: flow.name, testData, elementsProcessed: results.length, results, simulatedAt: new Date() });
  } catch (err) { next(err); }
});

// Flow elements CRUD
router.get('/:id/elements', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const elements = await prisma.flowElement.findMany({ where: { flowDefinitionId: req.params.id }, orderBy: { order: 'asc' } });
    res.json(elements);
  } catch (err) { next(err); }
});

router.post('/:id/elements', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { type, name, config, nextElementId } = req.body;
    if (!type || !name) return res.status(400).json({ error: 'type and name required' });
    const maxOrder = await prisma.flowElement.aggregate({ where: { flowDefinitionId: req.params.id }, _max: { order: true } });
    const el = await prisma.flowElement.create({ data: { flowDefinitionId: req.params.id, type, name, config: config || {}, nextElementId, order: (maxOrder._max.order || 0) + 1 } });
    res.status(201).json(el);
  } catch (err) { next(err); }
});

router.put('/:flowId/elements/:elementId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const el = await prisma.flowElement.update({ where: { id: req.params.elementId }, data: req.body });
    res.json(el);
  } catch (err) { next(err); }
});

router.delete('/:flowId/elements/:elementId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.flowElement.delete({ where: { id: req.params.elementId } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Flow version management
router.post('/:id/publish', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const flow = await prisma.flowDefinition.findUnique({ where: { id: req.params.id } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    const updated = await prisma.flowDefinition.update({ where: { id: req.params.id }, data: { status: 'Active', version: (flow.version || 0) + 1, publishedAt: new Date(), publishedById: req.user.id } });
    await req.audit({ action: 'update', module: 'flows', recordId: flow.id, details: `Published v${updated.version}` });
    res.json(updated);
  } catch (err) { next(err); }
});

// Flow statistics
router.get('/:id/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, success, failed] = await Promise.all([
      prisma.flowExecution.count({ where: { flowDefinitionId: req.params.id } }),
      prisma.flowExecution.count({ where: { flowDefinitionId: req.params.id, status: 'Completed' } }),
      prisma.flowExecution.count({ where: { flowDefinitionId: req.params.id, status: 'Failed' } }),
    ]);
    res.json({ totalExecutions: total, successful: success, failed, successRate: total ? Math.round(success / total * 100) : 0 });
  } catch (err) { next(err); }
});
