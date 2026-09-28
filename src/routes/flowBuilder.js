const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes, columnsFrom } = require('../utils/modelFields');
const router = Router();
router.use(authenticate);

// Paged and searched, with a total, as the Flow Builder page asks; its search
// box did nothing and every flow came back on every page.
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, status, type, search, page = 1, limit = 50 } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const current = Math.max(parseInt(page) || 1, 1);
    const where = {};
    if (module) where.module = module;
    if (status) where.status = status;
    if (type) where.type = type;
    if (search) where.name = { contains: String(search), mode: 'insensitive' };
    const [flows, total] = await Promise.all([
      prisma.flowDefinition.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (current - 1) * take, take }),
      prisma.flowDefinition.count({ where }),
    ]);
    res.json({ data: flows, total, page: current, pages: Math.ceil(total / take) });
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
      data: { ...columnsFrom('flowDefinition', req.body), createdById: req.userId, canvas: req.body.canvas || { nodes: [], edges: [] } },
    });
    await req.app.locals.prisma.flowVersion.create({ data: { flowId: flow.id, version: 1, canvas: flow.canvas } });
    res.status(201).json(flow);
  } catch (err) { next(err); }
});

router.put('/:id', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.flowDefinition.findUnique({ where: { id: req.params.id }, select: { id: true, canvas: true, version: true } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    // The edit form sends the whole row back. Its version and publish stamps
    // are the server's to move (a stale form rolled the version back), and a
    // null in its Json column is DbNull: a plain null failed every save.
    const data = columnsFrom('flowDefinition', req.body);
    for (const key of ['createdById', 'version', 'publishedAt', 'publishedById']) delete data[key];
    if (data.triggerConditions === null) data.triggerConditions = Prisma.DbNull;
    // Only a changed canvas is a new version; each save made one, since the
    // form sends the stored canvas back.
    const writes = [];
    if (req.body.canvas && JSON.stringify(req.body.canvas) !== JSON.stringify(current.canvas)) {
      const v = await prisma.flowVersion.findFirst({ where: { flowId: current.id }, orderBy: { version: 'desc' } });
      data.version = Math.max(v?.version || 0, current.version || 0) + 1;
      writes.push(prisma.flowVersion.create({ data: { flowId: current.id, version: data.version, canvas: req.body.canvas } }));
    }
    writes.push(prisma.flowDefinition.update({ where: { id: current.id }, data }));
    const flow = (await prisma.$transaction(writes)).pop();
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

// A run keeps a required link to its flow, so a flow that had ever run could
// not be deleted. Its runs and elements go with it; versions cascade.
router.delete('/:id', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const flow = await prisma.flowDefinition.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    await prisma.$transaction([
      prisma.flowRun.deleteMany({ where: { flowId: flow.id } }),
      prisma.flowElement.deleteMany({ where: { flowDefinitionId: flow.id } }),
      prisma.flowDefinition.delete({ where: { id: flow.id } }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

// Flow execution history
// A flow's runs are the FlowRun rows /run writes. This and /stats read
// FlowExecution, which nothing writes, so both were always empty.
router.get('/:id/executions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50 } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const [execs, total] = await Promise.all([
      prisma.flowRun.findMany({ where: { flowId: req.params.id }, orderBy: { startedAt: 'desc' }, skip: (Math.max(parseInt(page) || 1, 1) - 1) * take, take }),
      prisma.flowRun.count({ where: { flowId: req.params.id } }),
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
    if (!(await prisma.flowDefinition.findUnique({ where: { id: req.params.id }, select: { id: true } }))) return res.status(404).json({ error: 'Not found' });
    const maxOrder = await prisma.flowElement.aggregate({ where: { flowDefinitionId: req.params.id }, _max: { order: true } });
    const el = await prisma.flowElement.create({ data: { flowDefinitionId: req.params.id, type, name, config: config || {}, nextElementId, order: (maxOrder._max.order || 0) + 1 } });
    res.status(201).json(el);
  } catch (err) { next(err); }
});

// Only an element of the flow in the path, which it stays in. The element id
// alone reached any flow's elements, whatever flow the URL named.
router.put('/:flowId/elements/:elementId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const found = await prisma.flowElement.findFirst({ where: { id: req.params.elementId, flowDefinitionId: req.params.flowId }, select: { id: true } });
    if (!found) return res.status(404).json({ error: 'Not found' });
    const data = columnsFrom('flowElement', req.body);
    delete data.flowDefinitionId;
    const el = await prisma.flowElement.update({ where: { id: found.id }, data });
    res.json(el);
  } catch (err) { next(err); }
});

router.delete('/:flowId/elements/:elementId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { count } = await prisma.flowElement.deleteMany({ where: { id: req.params.elementId, flowDefinitionId: req.params.flowId } });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Flow version management
router.post('/:id/publish', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const flow = await prisma.flowDefinition.findUnique({ where: { id: req.params.id } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    // The published canvas is kept as that version. This moved the number on
    // with no version behind it, so the flow's history skipped what went live.
    const latest = await prisma.flowVersion.findFirst({ where: { flowId: flow.id }, orderBy: { version: 'desc' } });
    const version = Math.max(latest?.version || 0, flow.version || 0) + 1;
    const publishedAt = new Date();
    const [updated] = await prisma.$transaction([
      prisma.flowDefinition.update({ where: { id: flow.id }, data: { status: 'Active', version, publishedAt, publishedById: req.user.id } }),
      prisma.flowVersion.create({ data: { flowId: flow.id, version, canvas: flow.canvas, publishedAt, publishedById: req.user.id } }),
    ]);
    await req.audit({ action: 'update', module: 'flows', recordId: flow.id, details: `Published v${updated.version}` });
    res.json(updated);
  } catch (err) { next(err); }
});

// Flow statistics
router.get('/:id/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, success, failed] = await Promise.all([
      prisma.flowRun.count({ where: { flowId: req.params.id } }),
      prisma.flowRun.count({ where: { flowId: req.params.id, status: 'Completed' } }),
      prisma.flowRun.count({ where: { flowId: req.params.id, status: 'Failed' } }),
    ]);
    res.json({ totalExecutions: total, successful: success, failed, successRate: total ? Math.round(success / total * 100) : 0 });
  } catch (err) { next(err); }
});
