const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { invalidateOrgWideDefaultCache, invalidateHierarchyCache } = require('../middleware/rowSecurity');
const { columnsFrom } = require('../utils/modelFields');

const router = Router();
router.use(authenticate, requirePermission('admin', 'edit'));

// Org-wide defaults, the role hierarchy and field permissions decide who sees
// what; each change to them takes admin: full. admin: edit, which the default
// Sales Rep role has, was enough to open every record to everyone, or to set
// the hierarchy so one saw another's records.

// ─── VALIDATION RULES ───
router.get('/validation-rules', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.validationRule.findMany({ orderBy: { module: 'asc' } }) }); }
  catch (err) { next(err); }
});
router.post('/validation-rules', async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.validationRule.create({ data: columnsFrom('validationRule', req.body) })); }
  catch (err) { next(err); }
});
router.put('/validation-rules/:id', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.validationRule.update({ where: { id: req.params.id }, data: columnsFrom('validationRule', req.body) })); }
  catch (err) { next(err); }
});
router.delete('/validation-rules/:id', async (req, res, next) => {
  try { await req.app.locals.prisma.validationRule.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

// Validation engine: POST /validate/:module
router.post('/validate/:module', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.validationRule.findMany({ where: { module: req.params.module, active: true } });
    const errors = [];
    for (const rule of rules) {
      const cond = rule.condition || {};
      const val = req.body[cond.field];
      let fail = false;
      switch (cond.operator) {
        case 'required': fail = !val; break;
        case 'min_length': fail = val && val.length < cond.value; break;
        case 'max_length': fail = val && val.length > cond.value; break;
        case 'regex': fail = val && !new RegExp(cond.value).test(val); break;
        case 'gt': fail = Number(val) <= Number(cond.value); break;
        case 'lt': fail = Number(val) >= Number(cond.value); break;
        case 'in': fail = val && !cond.value.includes(val); break;
        case 'not_empty_if': {
          const dep = req.body[cond.dependentField];
          if (dep === cond.dependentValue) fail = !val;
          break;
        }
      }
      if (fail) errors.push({ rule: rule.name, field: rule.errorField || cond.field, message: rule.errorMessage });
    }
    res.json({ valid: errors.length === 0, errors });
  } catch (err) { next(err); }
});

// ─── RECORD TYPES ───
router.get('/record-types', async (req, res, next) => {
  try {
    const { module } = req.query;
    const where = module ? { module } : {};
    res.json({ data: await req.app.locals.prisma.recordType.findMany({ where, orderBy: { module: 'asc' } }) });
  } catch (err) { next(err); }
});
router.post('/record-types', async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.recordType.create({ data: columnsFrom('recordType', req.body) })); }
  catch (err) { next(err); }
});
router.put('/record-types/:id', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.recordType.update({ where: { id: req.params.id }, data: columnsFrom('recordType', req.body) })); }
  catch (err) { next(err); }
});
router.delete('/record-types/:id', async (req, res, next) => {
  try { await req.app.locals.prisma.recordType.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

// ─── PAGE LAYOUTS ───
router.get('/page-layouts', async (req, res, next) => {
  try {
    const { module } = req.query;
    const where = module ? { module } : {};
    res.json({ data: await req.app.locals.prisma.pageLayout.findMany({ where }) });
  } catch (err) { next(err); }
});
router.post('/page-layouts', async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.pageLayout.create({ data: columnsFrom('pageLayout', req.body) })); }
  catch (err) { next(err); }
});
router.put('/page-layouts/:id', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.pageLayout.update({ where: { id: req.params.id }, data: columnsFrom('pageLayout', req.body) })); }
  catch (err) { next(err); }
});
router.delete('/page-layouts/:id', async (req, res, next) => {
  try { await req.app.locals.prisma.pageLayout.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

// ─── ORG-WIDE DEFAULTS ───
router.get('/owd', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.orgWideDefault.findMany() }); }
  catch (err) { next(err); }
});
const ACCESS_LEVELS = ['Private', 'ReadOnly', 'ReadWrite', 'FullAccess'];
const GRANT_MODES = ['hierarchy', 'criteria'];

router.put('/owd/:module', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const { internalAccess, externalAccess, grantAccessUsing } = req.body;
    if (internalAccess !== undefined && !ACCESS_LEVELS.includes(internalAccess)) {
      return res.status(400).json({ error: `internalAccess must be one of: ${ACCESS_LEVELS.join(', ')}` });
    }
    if (externalAccess !== undefined && !ACCESS_LEVELS.includes(externalAccess)) {
      return res.status(400).json({ error: `externalAccess must be one of: ${ACCESS_LEVELS.join(', ')}` });
    }
    if (grantAccessUsing != null && !GRANT_MODES.includes(grantAccessUsing)) {
      return res.status(400).json({ error: `grantAccessUsing must be null or one of: ${GRANT_MODES.join(', ')}` });
    }
    const data = {
      ...(internalAccess !== undefined && { internalAccess }),
      ...(externalAccess !== undefined && { externalAccess }),
      ...(grantAccessUsing !== undefined && { grantAccessUsing }),
    };
    const owd = await req.app.locals.prisma.orgWideDefault.upsert({
      where: { module: req.params.module },
      update: data,
      create: { module: req.params.module, ...data },
    });
    // Sharing is cached for a minute; a change should apply now.
    invalidateOrgWideDefaultCache();
    res.json(owd);
  } catch (err) { next(err); }
});

// ─── FIELD-LEVEL SECURITY ───
router.get('/field-permissions', async (req, res, next) => {
  try {
    const { roleId, module } = req.query;
    const where = {};
    if (roleId) where.roleId = roleId;
    if (module) where.module = module;
    res.json({ data: await req.app.locals.prisma.fieldPermission.findMany({ where }) });
  } catch (err) { next(err); }
});
router.post('/field-permissions', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const fp = await req.app.locals.prisma.fieldPermission.upsert({
      where: { roleId_module_field: { roleId: req.body.roleId, module: req.body.module, field: req.body.field } },
      update: { visible: req.body.visible, editable: req.body.editable },
      create: req.body,
    });
    res.json(fp);
  } catch (err) { next(err); }
});
router.post('/field-permissions/bulk', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const { permissions } = req.body;
    const results = [];
    for (const p of permissions) {
      const fp = await req.app.locals.prisma.fieldPermission.upsert({
        where: { roleId_module_field: { roleId: p.roleId, module: p.module, field: p.field } },
        update: { visible: p.visible, editable: p.editable },
        create: p,
      });
      results.push(fp);
    }
    res.json({ data: results });
  } catch (err) { next(err); }
});

// ─── ROLE HIERARCHY ───
router.get('/role-hierarchy', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.roleHierarchy.findMany({ orderBy: { level: 'asc' } }) }); }
  catch (err) { next(err); }
});
router.put('/role-hierarchy/:roleId', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { roleId } = req.params;
    const parentId = req.body.parentId || null;
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true } });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (parentId) {
      if (parentId === roleId) return res.status(400).json({ error: 'A role cannot report to itself' });
      if (!(await prisma.role.findUnique({ where: { id: parentId }, select: { id: true } }))) {
        return res.status(400).json({ error: 'Parent role not found' });
      }
      // Walk up from the new parent: meeting this role means a loop, and a
      // loop would let two roles each see everything the other owns.
      const rows = await prisma.roleHierarchy.findMany({ select: { roleId: true, parentId: true } });
      const parentOf = new Map(rows.map(r => [r.roleId, r.parentId]));
      for (let at = parentId, steps = 0; at && steps <= rows.length; at = parentOf.get(at), steps++) {
        if (at === roleId) return res.status(400).json({ error: 'That parent would put the role above itself in the hierarchy' });
      }
    }
    const rh = await prisma.roleHierarchy.upsert({
      where: { roleId },
      update: { parentId, ...(req.body.level !== undefined && { level: req.body.level }) },
      create: { roleId, parentId, level: req.body.level || 0 },
    });
    invalidateHierarchyCache();
    res.json(rh);
  } catch (err) { next(err); }
});

module.exports = router;
