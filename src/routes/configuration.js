const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = Router();
router.use(authenticate, requirePermission('admin', 'edit'));

// ─── VALIDATION RULES ───
router.get('/validation-rules', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.validationRule.findMany({ orderBy: { module: 'asc' } }) }); }
  catch (err) { next(err); }
});
router.post('/validation-rules', async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.validationRule.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.put('/validation-rules/:id', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.validationRule.update({ where: { id: req.params.id }, data: req.body })); }
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
  try { res.status(201).json(await req.app.locals.prisma.recordType.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.put('/record-types/:id', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.recordType.update({ where: { id: req.params.id }, data: req.body })); }
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
  try { res.status(201).json(await req.app.locals.prisma.pageLayout.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.put('/page-layouts/:id', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.pageLayout.update({ where: { id: req.params.id }, data: req.body })); }
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
router.put('/owd/:module', async (req, res, next) => {
  try {
    const owd = await req.app.locals.prisma.orgWideDefault.upsert({
      where: { module: req.params.module },
      update: req.body,
      create: { module: req.params.module, ...req.body },
    });
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
router.post('/field-permissions', async (req, res, next) => {
  try {
    const fp = await req.app.locals.prisma.fieldPermission.upsert({
      where: { roleId_module_field: { roleId: req.body.roleId, module: req.body.module, field: req.body.field } },
      update: { visible: req.body.visible, editable: req.body.editable },
      create: req.body,
    });
    res.json(fp);
  } catch (err) { next(err); }
});
router.post('/field-permissions/bulk', async (req, res, next) => {
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
router.put('/role-hierarchy/:roleId', async (req, res, next) => {
  try {
    const rh = await req.app.locals.prisma.roleHierarchy.upsert({
      where: { roleId: req.params.roleId },
      update: { parentId: req.body.parentId, level: req.body.level },
      create: { roleId: req.params.roleId, parentId: req.body.parentId, level: req.body.level || 0 },
    });
    res.json(rh);
  } catch (err) { next(err); }
});

module.exports = router;
