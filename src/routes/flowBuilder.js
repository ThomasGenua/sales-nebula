const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { columnsFrom } = require('../utils/modelFields');
const { flowProblem, startFlow, resumeFlow } = require('../services/flowEngine');
const { resolveModel, evaluateConditions } = require('../services/workflowEngine');
const { reachableWhere } = require('../middleware/access');

const publicRun = run => run && ({ id: run.id, flowId: run.flowId, status: run.status, triggerRecordId: run.triggerRecordId, triggerModule: run.triggerModule, log: run.log, startedAt: run.startedAt, completedAt: run.completedAt, error: run.error });
const router = Router();
router.use(authenticate, requirePermission('admin', 'read'));
router.get('/field-metadata/:module', async (req, res, next) => {
  if (req.params.module.startsWith('custom:')) { try { const object = await req.app.locals.prisma.customObject.findFirst({ where: { id: req.params.module.slice(7), deletedAt: null }, include: { fields: true } }); if (!object) return res.status(404).json({ error: 'Object not found' }); return res.json({ fields: object.fields.map(f => ({ name: f.apiName, type: ['Number','Currency'].includes(f.type) ? 'Float' : f.type === 'Checkbox' ? 'Boolean' : 'String' })), relations: [] }); } catch (e) { return next(e); } }
  const { findModel } = require('../utils/modelFields');
  const model = findModel(resolveModel(req.params.module));
  const fields = (model?.fields || []).filter(f => f.kind !== 'object' && ['String', 'Int', 'Float', 'Boolean'].includes(f.type) && !f.name.endsWith('Id') && !['id', 'createdAt', 'updatedAt', 'deletedAt'].includes(f.name) && !require('../utils/modelFields').plainFieldProblem(model.name, f.name, f.type === 'String' ? '' : f.type === 'Boolean' ? false : 0)).map(f => ({ name: f.name, type: f.type }));
  res.json({ fields, relations: require('../services/relatedFlowActions').relations(req.params.module) });
});

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
    res.json({ ...flow, ...(flow.runs && { runs: flow.runs.map(publicRun) }) });
  } catch (err) { next(err); }
});

router.post('/', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const flow = await req.app.locals.prisma.flowDefinition.create({
      data: { ...columnsFrom('flowDefinition', req.body), status: 'Draft', createdById: req.userId, canvas: req.body.canvas || { nodes: [], edges: [] } },
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
    data.status = 'Draft';
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

// A flow is a stored design: nothing runs one (no trigger reads a flow, and
// no step was ever carried out). Activating, publishing, running and testing
// answered as if one ran: a run was "Completed" with each step "executed",
// a test "simulated" each element, and an active flow did nothing. They now
// say so, and change nothing.
router.post('/:id/activate', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const flow = await db.flowDefinition.findUnique({ where: { id: req.params.id } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    const problem = flowProblem(flow);
    if (problem) return res.status(400).json({ error: problem });
    res.json(await db.flowDefinition.update({ where: { id: flow.id }, data: { status: 'Active', ...(flow.type === 'Scheduled' && { nextRun: new Date() }), publishedAt: new Date(), publishedById: req.userId } }));
  } catch (err) { next(err); }
});

router.post('/:id/run', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const flow = await db.flowDefinition.findUnique({ where: { id: req.params.id } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    const problem = flowProblem(flow);
    if (problem) return res.status(400).json({ error: problem });
    if (!(flow.module.startsWith('custom:') ? require('../services/customObjectAccess').canAccess(req, flow.module.slice(7), 'edit') : permits(req, flow.module, 'edit'))) return res.status(403).json({ error: 'Edit permission is required for the trigger module' });
    if (!req.body.recordId) return res.status(400).json({ error: 'Choose a trigger record' });
    const customId = flow.module.startsWith('custom:') && flow.module.slice(7);
    const model = customId ? 'customRecord' : resolveModel(flow.module);
    const row = await db[model].findFirst({ where: customId ? { id: String(req.body.recordId), customObjectId: customId, deletedAt: null } : await reachableWhere(req, flow.module, model, { id: String(req.body.recordId) }, 'Edit') });
    const record = customId && row ? { ...row.data, id: row.id } : row;
    if (!record) return res.status(404).json({ error: 'Record not found' });
    res.json(publicRun(await startFlow(db, flow, record, req.userId)));
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
    res.json({ data: execs.map(publicRun), total, page: +page });
  } catch (err) { next(err); }
});

router.post('/:id/test', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const flow = await db.flowDefinition.findUnique({ where: { id: req.params.id } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    const problem = flowProblem(flow);
    if (problem) return res.status(400).json({ error: problem });
    if (!req.body.recordId) return res.status(400).json({ error: 'Choose a trigger record' });
    const customId = flow.module.startsWith('custom:') && flow.module.slice(7);
    if (!(customId ? require('../services/customObjectAccess').canAccess(req, customId, 'edit') : permits(req, flow.module, 'edit'))) return res.status(403).json({ error: 'Edit permission required' });
    const model = customId ? 'customRecord' : resolveModel(flow.module);
    const row = await db[model].findFirst({ where: customId ? { id: String(req.body.recordId), customObjectId: customId, deletedAt: null } : await reachableWhere(req, flow.module, model, { id: String(req.body.recordId) }, 'Edit') });
    const record = customId && row ? { ...row.data, id: row.id } : row;
    if (!record) return res.status(404).json({ error: 'Record not found' });
    const path = []; let node = flow.canvas.nodes.find(n => n.type === 'start');
    while (node) {
      path.push({ id: node.id, type: node.type });
      const branch = node.type === 'decision' ? String(evaluateConditions(node.config.conditions, record)) : null;
      const edge = flow.canvas.edges.find(e => e.source === node.id && (!branch || e.condition === branch));
      node = edge && flow.canvas.nodes.find(n => n.id === edge.target);
    }
    res.json({ dryRun: true, path, note: 'No actions executed. Branches use current record values.' });
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

router.post('/:id/publish', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const flow = await db.flowDefinition.findUnique({ where: { id: req.params.id } });
    if (!flow) return res.status(404).json({ error: 'Not found' });
    const problem = flowProblem(flow);
    if (problem) return res.status(400).json({ error: problem });
    res.json(await db.flowDefinition.update({ where: { id: flow.id }, data: { status: 'Active', ...(flow.type === 'Scheduled' && { nextRun: new Date() }), publishedAt: new Date(), publishedById: req.userId } }));
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

router.post('/:id/executions/:runId/retry', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const run = await db.flowRun.findFirst({ where: { id: req.params.runId, flowId: req.params.id, status: 'Failed' } });
    if (!run) return res.status(404).json({ error: 'Failed run not found' });
    res.json(publicRun(await resumeFlow(db, run.id, true)));
  } catch (err) { next(err); }
});
