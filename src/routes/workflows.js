const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { runWorkflows, resolveModel, workflowProblem, triggersFor } = require('../services/workflowEngine');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { plainFieldProblem } = require('../utils/modelFields');
const { auditMiddleware } = require('../middleware/audit');
const { visibleWhere } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');

/**
 * Triggers something fires: record writes fire create, update and
 * statusChange (utils/crud), matched by the engine's aliases, and the
 * scheduler runs 'scheduled'. A workflow saved with any other trigger
 * ("delete", "createOrUpdate") was accepted and never ran.
 */
const FIRED = ['create', 'update', 'statusChange'].flatMap(triggersFor);
const triggerProblem = trigger => (FIRED.includes(String(trigger).toLowerCase()) || trigger === 'scheduled'
  ? null : 'trigger must be one of: create, update, statusChange, scheduled');

// Those record events fire under the CRUD router's module names (deals,
// personAccounts), matched exactly: a workflow on "Deals", or on a module
// with its own router (quotes), was saved and never ran.
const moduleProblem = (module, trigger) => (trigger === 'scheduled' || crudModelFor(module)
  ? null : `${module} records do not run workflows; use a record module such as deals, leads or contacts`);

// A Json column is emptied with DbNull and refuses a plain null. The form
// sends a workflow back with `conditions: null`, so saving or duplicating one
// without conditions or actions failed.
const withJsonNulls = data => {
  for (const key of ['conditions', 'actions']) if (data[key] === null) data[key] = Prisma.DbNull;
  return data;
};

/**
 * The fields a workflow is saved with. The body went to Prisma whole, so it
 * could set run counts or write logs, and actions were never looked at.
 */
function workflowFields(body) {
  const b = body || {};
  const data = {};
  for (const key of ['name', 'description', 'module', 'trigger']) {
    if (b[key] !== undefined) data[key] = b[key] === null ? null : String(b[key]);
  }
  for (const key of ['conditions', 'actions']) {
    if (b[key] !== undefined) data[key] = b[key];
  }
  if (b.active !== undefined) data.active = !!b.active;
  return data;
}

const router = Router();
router.use(authenticate, auditMiddleware);
const BUILDER_MODULES = ['leads', 'contacts', 'accounts', 'deals', 'activities', 'cases'];
async function checkOwners(req, data) {
  const assigning = (data.actions || []).filter(a => a.type === 'assignOwner');
  if (!assigning.length) return;
  if (!permits(req, 'admin', 'edit')) throw Object.assign(new Error('Administrator edit permission is required to automate owner assignment.'), { status: 403 });
  for (const action of assigning) if (!await req.app.locals.prisma.user.findFirst({ where: { id: action.config.userId, active: true, isPortalUser: false }, select: { id: true } })) throw Object.assign(new Error('Choose an active team member.'), { status: 400 });
}
router.get('/builder/metadata', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const modules = Object.fromEntries(BUILDER_MODULES.filter(module => permits(req, module, 'read')).map(module => {
      const model = Prisma.dmmf.datamodel.models.find(m => m.name.toLowerCase() === resolveModel(module)?.toLowerCase());
      return [module, (model?.fields || []).filter(f => f.kind === 'scalar' && !['Json', 'Bytes'].includes(f.type) && !f.isList).map(f => ({ name: f.name, type: f.type, writable: !plainFieldProblem(resolveModel(module), f.name, f.type === 'String' ? '' : f.type === 'Boolean' ? false : f.type === 'DateTime' ? new Date().toISOString() : 0) }))];
    }));
    const assign = permits(req, 'admin', 'edit');
    const users = assign ? await req.app.locals.prisma.user.findMany({ where: { active: true, isPortalUser: false }, select: { id: true, firstName: true, lastName: true }, take: 1000, orderBy: { firstName: 'asc' } }) : [];
    res.json({ modules, assign, users, operators: [...require('../services/workflowEngine').COMPARE_OPERATORS, 'changed', 'changedTo'] });
  } catch (e) { next(e); }
});
router.post('/preview', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const definition = workflowFields(req.body), model = crudModelFor(definition.module);
    const problem = workflowProblem(definition) || triggerProblem(definition.trigger) || moduleProblem(definition.module, definition.trigger);
    if (problem || !model) return res.status(400).json({ error: problem || 'Unsupported module' });
    if (!permits(req, definition.module, 'read')) return res.status(403).json({ error: 'Insufficient permissions' });
    const record = await req.app.locals.prisma[model].findFirst({ where: await reachableWhere(req, definition.module, model, { id: String(req.body.recordId || '') }) });
    if (!record) return res.status(404).json({ error: 'Choose a record you can read.' });
    const matched = require('../services/workflowEngine').evaluateConditions(definition.conditions, record, req.body.previous || null);
    res.json({ matched, actions: matched ? definition.actions || [] : [], changed: false });
  } catch (e) { next(e); }
});

// LIST
// Paged and searched, with a total, as the Workflows page asks; its search
// box did nothing and every workflow came back on every page.
router.get('/', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const current = Math.max(parseInt(page) || 1, 1);
    const where = search ? { name: { contains: String(search), mode: 'insensitive' } } : {};
    const [workflows, total] = await Promise.all([
      prisma.workflow.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (current - 1) * take, take }),
      prisma.workflow.count({ where }),
    ]);
    res.json({ data: workflows, total, page: current, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// GET ONE with logs
router.get('/:id', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const workflow = await prisma.workflow.findUnique({
      where: { id: req.params.id },
      include: { logs: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    if (!workflow) return res.status(404).json({ error: 'Not found' });
    res.json(workflow);
  } catch (err) { next(err); }
});

// CREATE
router.post('/', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = workflowFields(req.body);
    if (!data.name || !data.module || !data.trigger) return res.status(400).json({ error: 'name, module and trigger are required' });
    const problem = workflowProblem(data) || triggerProblem(data.trigger) || moduleProblem(data.module, data.trigger);
    if (problem) return res.status(400).json({ error: problem });
    await checkOwners(req, data);
    const workflow = await prisma.workflow.create({ data: withJsonNulls(data) });
    await req.audit({ action: 'create', module: 'workflows', recordId: workflow.id });
    res.status(201).json(workflow);
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.workflow.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const data = workflowFields(req.body);
    const saved = { ...current, ...data };
    const problem = workflowProblem(saved)
      || (data.trigger !== undefined && triggerProblem(data.trigger))
      || ((data.module !== undefined || data.trigger !== undefined) && moduleProblem(saved.module, saved.trigger));
    if (problem) return res.status(400).json({ error: problem });
    await checkOwners(req, saved);
    const workflow = await prisma.workflow.update({ where: { id: req.params.id }, data: withJsonNulls(data) });
    res.json(workflow);
  } catch (err) { next(err); }
});

// TOGGLE active
router.post('/:id/toggle', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const wf = await prisma.workflow.findUnique({ where: { id: req.params.id } });
    if (!wf) return res.status(404).json({ error: 'Not found' });
    await checkOwners(req, wf);
    const updated = await prisma.workflow.update({ where: { id: req.params.id }, data: { active: !wf.active } });
    res.json(updated);
  } catch (err) { next(err); }
});

// DUPLICATE
router.post('/:id/duplicate', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const wf = await prisma.workflow.findUnique({ where: { id: req.params.id } });
    if (!wf) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, runCount, lastRun, ...data } = wf;
    await checkOwners(req, wf);
    const copy = await prisma.workflow.create({ data: withJsonNulls({ ...data, name: `${data.name} (Copy)`, runCount: 0 }) });
    res.status(201).json(copy);
  } catch (err) { next(err); }
});

// DELETE
router.delete('/:id', requirePermission('workflows', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.workflow.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET LOGS
router.get('/logs/all', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Runs only: a scheduled rule also logs 'scheduled-unmatched' when a record
    // it acted on stops matching (src/jobs/scheduler.js), which is bookkeeping
    // that lets it act again, not a run.
    const logs = await prisma.workflowLog.findMany({ where: { trigger: { not: 'scheduled-unmatched' } }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ data: logs });
  } catch (err) { next(err); }
});

// POST /api/workflows/execute - Run matching workflows for a trigger event
/**
 * Run the rules for a record on demand.
 *
 * The engine used to live inline here and this was its only caller — which
 * nothing called. It now shares src/services/workflowEngine.js with the write
 * paths and the scheduler, so a rule behaves the same however it is reached.
 */
router.post('/execute', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, trigger, record: given, oldRecord } = req.body || {};
    if (!module || !trigger || !given?.id) {
      return res.status(400).json({ error: 'module, trigger and record.id are required' });
    }
    // The record as stored, and only one the caller can see. Anyone signed
    // in could run every rule against a record they described themselves:
    // any id, with whatever fields made the conditions match.
    const modelName = resolveModel(module);
    const record = modelName && await prisma[modelName].findFirst({
      where: await visibleWhere(req, String(module), modelName, { id: String(given.id) }),
    });
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const results = await runWorkflows(prisma, {
      module: String(module), trigger, record, oldRecord, userId: req.userId,
    });
    res.json({ executed: results.length, results });
  } catch (err) { next(err); }
});

module.exports = router;
