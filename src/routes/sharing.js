const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { isAdmin, invalidateSharingRuleCache } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');
const { scalarSelect } = require('../utils/modelFields');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── WHAT A RULE MAY SAY ───
// Rules were stored as sent, and one the evaluator (middleware/rowSecurity)
// cannot read shares nothing, silently. These are the shapes it applies.
const RULE_TYPES = ['criteria_based', 'owner_based', 'manual'];
const TARGET_TYPES = ['user', 'role', 'group'];
const RULE_LEVELS = ['read', 'edit', 'full'];
// The criteria operators the evaluator knows, compared in lower case.
const OPERATORS = ['equals', 'eq', 'notequals', 'not_equals', 'neq', 'in', 'notin', 'not_in', 'contains',
  'startswith', 'starts_with', 'greaterthan', 'gt', 'gte', 'lessthan', 'lt', 'lte'];
// Record modules outside the CRUD router that still apply row security.
const OTHER_MODELS = { quotes: 'quote', invoices: 'invoice', projects: 'project', emails: 'email' };
const ruleModelFor = module => (typeof module === 'string' && (crudModelFor(module)
  || (Object.prototype.hasOwnProperty.call(OTHER_MODELS, module) ? OTHER_MODELS[module] : null))) || null;

/** `{ type: user | role | group, value }`, the value one name or id, or a list of them. */
const isTarget = t => !!t && typeof t === 'object' && !Array.isArray(t) && TARGET_TYPES.includes(t.type)
  && [].concat(t.value ?? []).length > 0 && [].concat(t.value).every(v => typeof v === 'string' && v.trim());

/** Why the evaluator could not apply a rule as written, or null. */
function ruleProblem({ module, type, sharedFrom, sharedTo, accessLevel }) {
  const modelName = ruleModelFor(module);
  if (!modelName) return `Sharing is not available for ${module}`;
  if (!RULE_TYPES.includes(type)) return `type must be one of: ${RULE_TYPES.join(', ')}`;
  if (!isTarget(sharedTo)) return 'sharedTo must be { type: user | role | group, value }';
  if (!RULE_LEVELS.includes(accessLevel)) return `accessLevel must be one of: ${RULE_LEVELS.join(', ')}`;
  if (type === 'criteria_based') {
    const from = sharedFrom && typeof sharedFrom === 'object' && !Array.isArray(sharedFrom) ? sharedFrom : null;
    if (!from || from.value === undefined) return 'A criteria_based rule needs sharedFrom { field, operator, value }';
    if (typeof from.field !== 'string' || !scalarSelect(modelName, [from.field])?.[from.field]) return `sharedFrom.field must be a column of ${module}`;
    if (!OPERATORS.includes(String(from.operator ?? 'equals').toLowerCase())) return `sharedFrom.operator must be one of: ${OPERATORS.join(', ')}`;
  }
  if (type === 'owner_based' && sharedFrom != null && !isTarget(sharedFrom)) {
    return "An owner_based rule's sharedFrom, when given, must be { type: user | role | group, value }";
  }
  return null;
}

// ─── SHARING RULES CRUD ───

// List sharing rules
router.get('/rules', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.query;
    const where = module ? { module } : {};
    const rules = await prisma.sharingRule.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: rules });
  } catch (err) { next(err); }
});

// Create sharing rule
router.post('/rules', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, type, sharedFrom, sharedTo, accessLevel, active } = req.body;
    if (!name || !module || !type) {
      return res.status(400).json({ error: 'name, module, and type required' });
    }
    const level = String(accessLevel || 'read').toLowerCase();
    const problem = ruleProblem({ module, type, sharedFrom, sharedTo, accessLevel: level });
    if (problem) return res.status(400).json({ error: problem });

    const rule = await prisma.sharingRule.create({
      data: {
        name, module, type,
        // A Json column refuses a plain null: a rule without sharedFrom was a 500.
        sharedFrom: sharedFrom || Prisma.DbNull,
        sharedTo,
        accessLevel: level,
        active: active !== false,
        createdById: req.userId,
      },
    });
    // Row security caches rules for a minute; this one applies now.
    invalidateSharingRuleCache();

    await req.audit({ action: 'create', module: 'settings', recordId: rule.id, details: `Created sharing rule: ${name}` });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// Update sharing rule
router.put('/rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, sharedFrom, sharedTo, accessLevel, active } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (sharedFrom !== undefined) data.sharedFrom = sharedFrom === null ? Prisma.DbNull : sharedFrom;
    if (sharedTo !== undefined) data.sharedTo = sharedTo;
    if (accessLevel !== undefined) data.accessLevel = String(accessLevel).toLowerCase();
    if (active !== undefined) data.active = active;

    // A change to what the rule shares is checked as a new rule is, against
    // the rule as it will stand. Renaming or switching it off always works.
    if (sharedFrom !== undefined || sharedTo !== undefined || accessLevel !== undefined) {
      const current = await prisma.sharingRule.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Not found' });
      const problem = ruleProblem({
        module: current.module, type: current.type,
        sharedFrom: sharedFrom !== undefined ? sharedFrom : current.sharedFrom,
        sharedTo: sharedTo !== undefined ? sharedTo : current.sharedTo,
        accessLevel: data.accessLevel ?? String(current.accessLevel).toLowerCase(),
      });
      if (problem) return res.status(400).json({ error: problem });
    }

    const rule = await prisma.sharingRule.update({ where: { id: req.params.id }, data });
    invalidateSharingRuleCache();
    res.json(rule);
  } catch (err) { next(err); }
});

// Delete sharing rule
router.delete('/rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.sharingRule.delete({ where: { id: req.params.id } });
    invalidateSharingRuleCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── RECORD-LEVEL SHARING ───

// Share a specific record with a user
// Only a live record the caller may change, with an active user, at no more
// than the caller holds: sharing takes edit on the module and Edit on the
// record, and granting full takes full on both. This took any module, record,
// user and level from anyone signed in.
router.post('/records', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, userId, accessLevel } = req.body;
    if (!module || !recordId || !userId) {
      return res.status(400).json({ error: 'module, recordId, userId required' });
    }
    const level = String(accessLevel || 'read').toLowerCase();
    if (!['read', 'edit', 'full'].includes(level)) return res.status(400).json({ error: 'accessLevel must be read, edit or full' });
    const modelName = typeof module === 'string' ? crudModelFor(module) : null;
    if (!modelName) return res.status(400).json({ error: `Sharing is not available for ${module}` });
    if (!permits(req, module, level === 'full' ? 'full' : 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const record = await prisma[modelName].findFirst({
      where: await reachableWhere(req, module, modelName, { id: String(recordId) }, level === 'full' ? 'Full' : 'Edit'),
      select: { id: true },
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    const user = await prisma.user.findFirst({ where: { id: String(userId), active: true }, select: { id: true } });
    if (!user) return res.status(400).json({ error: 'userId does not name an active user' });

    const share = await prisma.recordShare.create({
      data: {
        module, recordId: record.id,
        sharedWithId: user.id,
        accessLevel: level,
        sharedById: req.userId,
      },
    });

    res.status(201).json(share);
  } catch (err) { next(err); }
});

// List who a record is shared with
// Only for a record the caller can see, with the module's read permission:
// this listed the shares on any record, and who they went to.
router.get('/records/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    const modelName = crudModelFor(module);
    if (!modelName) return res.status(400).json({ error: `Sharing is not available for ${module}` });
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const record = await prisma[modelName].findFirst({
      where: await reachableWhere(req, module, modelName, { id: String(recordId) }),
      select: { id: true },
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    const shares = await prisma.recordShare.findMany({
      where: { module, recordId: record.id },
    });

    // Hydrate user info
    const userIds = [...new Set(shares.map(s => s.sharedWithId))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const data = shares.map(s => ({
      ...s,
      sharedWith: userMap[s.sharedWithId] || null,
    }));

    res.json({ data });
  } catch (err) { next(err); }
});

// Remove record share
// By whoever shared it, an admin, or someone who may change the record: the
// module's edit permission and Edit on the record. Anyone signed in could
// delete any share.
router.delete('/records/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const share = await prisma.recordShare.findUnique({ where: { id: req.params.id } });
    if (!share) return res.status(404).json({ error: 'Not found' });
    if (share.sharedById !== req.userId && !isAdmin(req.user)) {
      const modelName = crudModelFor(share.module);
      if (modelName && !permits(req, share.module, 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${share.module}` });
      const record = modelName && await prisma[modelName].findFirst({
        where: await reachableWhere(req, share.module, modelName, { id: share.recordId }, 'Edit'),
        select: { id: true },
      });
      if (!record) return res.status(404).json({ error: 'Not found' });
    }
    await prisma.recordShare.delete({ where: { id: share.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── CHECK ACCESS (utility endpoint for frontend) ───
// Row security's own answer at each level, with the module permission each
// takes. This claimed access to any record in a module with an active rule,
// whoever the rule named. `via` is 'direct' when a share to the caller is part
// of it, 'other' for ownership, groups, the org-wide default or a rule.
router.get('/check/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    const modelName = ruleModelFor(module);
    if (!modelName) return res.status(400).json({ error: `Sharing is not available for ${module}` });

    const reaches = async (permission, minLevel) => permits(req, module, permission) && !!(await prisma[modelName].findFirst({
      where: await reachableWhere(req, module, modelName, { id: String(recordId) }, minLevel),
      select: { id: true },
    }));
    const read = await reaches('read', 'Read');
    const edit = read && await reaches('edit', 'Edit');
    const full = edit && await reaches('full', 'Full');

    // Check direct record share
    const directShare = await prisma.recordShare.findFirst({
      where: { module, recordId: String(recordId), sharedWithId: req.userId },
    });

    res.json({
      hasAccess: read,
      accessLevel: full ? 'full' : edit ? 'edit' : read ? 'read' : 'none',
      via: !read ? 'none' : directShare ? 'direct' : 'other',
    });
  } catch (err) { next(err); }
});

module.exports = router;
