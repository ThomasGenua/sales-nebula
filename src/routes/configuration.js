const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { invalidateOrgWideDefaultCache, invalidateHierarchyCache } = require('../middleware/rowSecurity');
const { columnsFrom } = require('../utils/modelFields');
const { checkValidationRules } = require('../services/recordRules');

const { unavailable } = require('../utils/unavailable');
const router = Router();
router.use(authenticate);
router.get('/record-metadata/:module', async (req, res, next) => {
  try {
    if (!require('../middleware/auth').permits(req, req.params.module, 'read')) return res.status(403).json({ error: 'Insufficient permissions' });
    res.json({ ...await require('../services/recordTypes').metadata(req.app.locals.prisma, req.params.module, req.user), fieldPermissions: (await require('../services/fieldSecurity').policies(req.app.locals.prisma)).filter(p => p.module === req.params.module) });
  } catch (err) { next(err); }
});
router.use(requirePermission('admin', 'edit'));
router.get('/field-catalog', async (req, res, next) => {
  try {
  const { Prisma } = require('@prisma/client');
  const { modelModules, validField } = require('../services/fieldSecurity');
  const catalog = Object.fromEntries(Object.entries(modelModules).map(([model, module]) => [module, Prisma.dmmf.datamodel.models.find(m => m.name === model).fields.filter(f => validField(module, f.name)).map(f => ({ name: f.name, type: f.type }))]));
  for (const field of await req.app.locals.prisma.customFieldDef.findMany({ where: { active: true, deletedAt: null } })) if (catalog[field.module]) catalog[field.module].push({ name: 'custom.' + field.name, type: field.fieldType });
  res.json(catalog);
  } catch (err) { next(err); }
});

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
// The rules as saves enforce them (services/recordRules). This had its own
// engine, whose operators the stored rules do not use and which read a
// matching condition as a pass where saves read it as a failure, so it
// called records valid that a save would refuse.
router.post('/validate/:module', async (req, res, next) => {
  try {
    const record = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const errors = await checkValidationRules(req.app.locals.prisma, req.params.module, record);
    res.json({ valid: errors.length === 0, errors });
  } catch (err) { next(err); }
});

function validateConfig(table) { return async (req,res,next) => { try {
  const current = req.params.id ? await req.app.locals.prisma[table].findUnique({ where: { id: req.params.id } }) : {};
  if (!current) return res.status(404).json({ error: 'Not found' });
  await require('../services/recordTypes').validateConfiguration(req.app.locals.prisma, table, { ...current, ...req.body }); next();
} catch(e) { next(e); } }; }
// ─── RECORD TYPES ───
router.get('/record-types', async (req, res, next) => {
  try {
    const { module } = req.query;
    const where = module ? { module } : {};
    res.json({ data: await req.app.locals.prisma.recordType.findMany({ where, orderBy: { module: 'asc' } }) });
  } catch (err) { next(err); }
});
router.post('/record-types', requirePermission('admin', 'full'), validateConfig('recordType'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.recordType.create({ data: columnsFrom('recordType', req.body) })); }
  catch (err) { next(err); }
});
router.put('/record-types/:id', requirePermission('admin', 'full'), validateConfig('recordType'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.recordType.update({ where: { id: req.params.id }, data: columnsFrom('recordType', req.body) })); }
  catch (err) { next(err); }
});
router.delete('/record-types/:id', requirePermission('admin', 'full'), async (req, res, next) => {
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
router.post('/page-layouts', requirePermission('admin', 'full'), validateConfig('pageLayout'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.pageLayout.create({ data: columnsFrom('pageLayout', req.body) })); }
  catch (err) { next(err); }
});
router.put('/page-layouts/:id', requirePermission('admin', 'full'), validateConfig('pageLayout'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.pageLayout.update({ where: { id: req.params.id }, data: columnsFrom('pageLayout', req.body) })); }
  catch (err) { next(err); }
});
router.delete('/page-layouts/:id', requirePermission('admin', 'full'), async (req, res, next) => {
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
async function savePermissions(req, res, next) {
  try {
    const rows = req.path.endsWith('/bulk') ? req.body.permissions : [req.body];
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) return res.status(400).json({ error: 'Provide 1–200 permissions' });
    const db = req.app.locals.prisma;
    for (const row of rows) {
      const custom = typeof row.field === 'string' && row.field.startsWith('custom.') && await db.customFieldDef.findFirst({ where: { module: row.module, name: row.field.slice(7), active: true, deletedAt: null } });
      if ((!custom && !require('../services/fieldSecurity').validField(row.module, row.field)) || typeof row.visible !== 'boolean' || typeof row.editable !== 'boolean') return res.status(400).json({ error: 'Choose a supported record field and boolean permissions' });
      if (!await db.role.findUnique({ where: { id: String(row.roleId) } })) return res.status(400).json({ error: 'Role not found' });
    }
    const data = await db.$transaction(rows.map(({roleId, module, field, visible, editable}) => db.fieldPermission.upsert({ where: { roleId_module_field: {roleId, module, field} }, create: {roleId, module, field, visible, editable: visible && editable}, update: {visible, editable: visible && editable} })));
    res.json({ data });
  } catch (err) { next(err); }
}
router.post('/field-permissions', requirePermission('admin', 'full'), savePermissions);
router.post('/field-permissions/bulk', requirePermission('admin', 'full'), savePermissions);

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
