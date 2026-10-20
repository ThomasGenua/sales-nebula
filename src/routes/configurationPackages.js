const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const { authenticate, requirePermission } = require('../middleware/auth');
const { workflowProblem, resolveModel } = require('../services/workflowEngine');
const { KEY, validateRequirements } = require('../services/dealCoaching');
const { audit } = require('../middleware/audit');
const router = Router();
router.use(authenticate, requirePermission('admin', 'full'));
const tables = {
  workflows: ['workflow', ['id', 'name', 'description', 'module', 'trigger', 'conditions', 'actions', 'active']],
  validationRules: ['validationRule', ['id', 'name', 'description', 'module', 'condition', 'errorMessage', 'errorField', 'active']],
};
const pick = (row, fields) => Object.fromEntries(fields.map(f => [f, row[f] ?? null]));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const stable = v => JSON.stringify(v, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
const hash = v => crypto.createHash('sha256').update(stable(v)).digest('hex');
const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
async function snapshot(db) {
  const bundle = { version: 1 };
  for (const [key, [model, fields]] of Object.entries(tables)) bundle[key] = (await db[model].findMany({ orderBy: { id: 'asc' } })).map(r => pick(r, fields));
  const requirements = await db.setting.findUnique({ where: { key: KEY } });
  bundle.stageRequirements = requirements ? JSON.parse(requirements.value) : {};
  return bundle;
}
function conditionProblem(node, fields, depth = 0) {
  if (depth > 10 || !node || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.some(n => conditionProblem(n, fields, depth + 1));
  for (const key of ['and', 'or']) if (node[key]) return !Array.isArray(node[key]) || node[key].some(n => conditionProblem(n, fields, depth + 1));
  if (node.not) return conditionProblem(node.not, fields, depth + 1);
  return !fields.includes(node.field) || !['equals', 'eq', 'notEquals', 'ne', 'contains', 'startsWith', 'greaterThan', 'gt', 'lessThan', 'lt', 'gte', 'lte', 'isEmpty', 'isNotEmpty', 'in', 'lengthLt', 'lengthGt'].includes(node.operator);
}
async function validate(db, bundle) {
  if (bundle?.version !== 1 || Object.keys(bundle).some(k => !['version', ...Object.keys(tables), 'stageRequirements'].includes(k))) fail('Unsupported configuration package');
  validateRequirements(bundle.stageRequirements);
  for (const [key, [, fields]] of Object.entries(tables)) {
    if (!Array.isArray(bundle[key]) || bundle[key].length > 1000) fail(`Provide at most 1,000 ${key}`);
    const ids = new Set();
    for (const row of bundle[key]) {
      if (!row || Object.keys(row).some(f => !fields.includes(f)) || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id) || ids.has(row.id)) fail(`Invalid or duplicate ${key} ID`);
      ids.add(row.id);
      if (typeof row.name !== 'string' || !row.name.trim() || typeof row.active !== 'boolean') fail(`Invalid ${key} name or active flag`);
      if (row.description != null && typeof row.description !== 'string') fail(`Invalid ${key} description`);
      const model = resolveModel(row.module), meta = Prisma.dmmf.datamodel.models.find(m => m.name.toLowerCase() === model?.toLowerCase());
      if (!meta) fail(`Unknown module: ${row.module}`);
      if (key === 'workflows') {
        const problem = workflowProblem(row);
        if (problem) fail(problem);
        if (!['create', 'update', 'statusChange', 'scheduled'].includes(row.trigger)) fail('Unsupported workflow trigger');
        for (const action of row.actions || []) {
          const userId = action.config?.userId;
          if (userId && !await db.user.findFirst({ where: { id: userId, active: true, isPortalUser: false } })) fail(`Missing active user dependency: ${userId}`);
          const templateId = action.config?.templateId;
          if (templateId && !await db.emailTemplate.findUnique({ where: { id: templateId } })) fail(`Missing email template dependency: ${templateId}`);
        }
      } else {
        if (typeof row.errorMessage !== 'string' || !row.errorMessage.trim() || conditionProblem(row.condition, meta.fields.filter(f => f.kind === 'scalar').map(f => f.name))) fail(`Invalid validation rule: ${row.name}`);
      }
    }
    bundle[key].sort((a, b) => a.id.localeCompare(b.id));
  }
  return bundle;
}
function changes(before, after) {
  const result = [];
  for (const key of Object.keys(tables)) {
    const old = new Map(before[key].map(r => [r.id, r])), updated = new Map(after[key].map(r => [r.id, r]));
    for (const row of after[key]) {
      if (!old.has(row.id) || stable(row) !== stable(old.get(row.id))) result.push({ type: key, name: row.name, action: old.has(row.id) ? 'update' : 'create' });
    }
    for (const row of before[key]) if (!updated.has(row.id)) result.push({ type: key, name: row.name, action: 'delete' });
  }
  if (stable(before.stageRequirements) !== stable(after.stageRequirements)) result.push({ type: 'stageRequirements', name: 'Deal stage requirements', action: 'update' });
  return result;
}
async function apply(db, bundle, expectedHash, userId, label) {
  return db.$transaction(async tx => {
    const before = await snapshot(tx);
    if (hash(before) !== expectedHash) fail('Configuration changed. Preview again before applying.', 409);
    await validate(tx, bundle);
    for (const [key, [model, fields]] of Object.entries(tables)) {
      await tx[model].deleteMany({ where: { id: { notIn: bundle[key].map(r => r.id) } } });
      for (const row of bundle[key]) {
        const data = pick(row, fields);
        for (const f of ['actions', 'conditions']) if (f in data && data[f] === null) data[f] = Prisma.DbNull;
        await tx[model].upsert({ where: { id: row.id }, create: data, update: data });
      }
    }
    const value = JSON.stringify(bundle.stageRequirements);
    await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value, category: 'sales', updatedById: userId }, update: { value, updatedById: userId } });
    const after = await snapshot(tx);
    const revision = await tx.configurationRevision.create({ data: { before, after, label, createdById: userId } });
    await audit(tx, { action: 'update', module: 'settings', recordId: revision.id, details: label, userId });
    return { revisionId: revision.id, hash: hash(after), changes: changes(before, after) };
  }, { isolationLevel: 'Serializable', timeout: 30000 });
}
router.get('/export', wrap(async (req, res) => {
  const bundle = await snapshot(req.app.locals.prisma);
  res.json({ bundle, hash: hash(bundle), scope: 'Workflow rules, validation rules and deal stage requirements. Credentials and records are excluded.' });
}));
router.post('/preview', wrap(async (req, res) => {
  const db = req.app.locals.prisma, bundle = await validate(db, req.body.bundle), before = await snapshot(db);
  res.json({ baseHash: hash(before), bundleHash: hash(bundle), changes: changes(before, bundle) });
}));
router.post('/apply', wrap(async (req, res) => {
  const bundle = await validate(req.app.locals.prisma, req.body.bundle);
  if (hash(bundle) !== req.body.bundleHash) fail('Package changed. Preview it again.', 409);
  res.json(await apply(req.app.locals.prisma, bundle, req.body.baseHash, req.userId, String(req.body.label || 'Configuration import').slice(0, 200)));
}));
router.get('/history', wrap(async (req, res) => {
  res.json(await req.app.locals.prisma.configurationRevision.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, label: true, createdAt: true, createdById: true } }));
}));
router.get('/history/:id', wrap(async (req, res) => {
  const revision = await req.app.locals.prisma.configurationRevision.findUnique({ where: { id: req.params.id } });
  if (!revision) fail('Revision not found', 404);
  res.json({ bundle: revision.before, label: `Restore before ${revision.label}` });
}));
module.exports = router;
