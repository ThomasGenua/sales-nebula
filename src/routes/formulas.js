const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { evaluateFormula } = require('../utils/formula');
const { crudModelFor } = require('../utils/crud');
const { pickModelFields } = require('../utils/modelFields');

/**
 * The model for a record module the caller may read; otherwise it answers and
 * returns null. These took any module name as a table, and any record in it.
 */
function readableModel(req, res, module) {
  const modelName = typeof module === 'string' ? crudModelFor(module) : null;
  if (!modelName) { res.status(400).json({ error: `Formulas are not available for ${module}` }); return null; }
  if (!permits(req, module, 'read')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return null; }
  return modelName;
}

const router = Router();
router.use(authenticate, auditMiddleware);

// Formulas are parsed and interpreted, never run as code (utils/formula).
// LIST formula fields
router.get('/', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.query;
    let where = {};
    if (module) where.module = module;
    const fields = await prisma.formulaField.findMany({ where, orderBy: { module: 'asc' } });
    res.json({ data: fields });
  } catch (err) { next(err); }
});

// CREATE
router.post('/', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, formula = '0', returnType, precision, rollup } = req.body;
    require('../services/computedFields').validate({name,module,formula,rollup,precision});
    if (!name || !module || !formula) return res.status(400).json({ error: 'name, module, and formula required' });
    const fieldKey = `ff_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const field = await prisma.formulaField.create({
      data: { name, fieldKey, module, formula, returnType: returnType || 'text', precision, ...(rollup&&{rollup}) },
    });
    await req.audit({ action: 'create', module: 'settings', recordId: field.id, details: `Created formula field: ${name}` });
    res.status(201).json(field);
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, updatedAt, ...rest } = req.body || {};
    const { data } = pickModelFields('formulaField', rest);
    const current=await prisma.formulaField.findUnique({where:{id:req.params.id}});
    if(!current)return res.status(404).json({error:'Not found'});
    require('../services/computedFields').validate({...current,...data});
    const field = await prisma.formulaField.update({ where: { id: req.params.id }, data });
    res.json(field);
  } catch (err) { next(err); }
});

// DELETE
router.delete('/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.formulaField.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// TEST a formula against a sample record
router.post('/test', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    // Accept either name: this is the "test against sample data" endpoint and
    // callers reasonably send sampleData. Reading only `record` meant the
    // formula was evaluated against {} and every variable came back undefined.
    const { formula, record, sampleData } = req.body;
    const result = evaluateFormula(formula, sampleData || record || {});
    res.json({ formula, result, type: typeof result });
  } catch (err) { next(err); }
});

// EVALUATE formula fields for a specific record
router.post('/evaluate', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.body;

    // Get the record, if the caller can see it
    const modelName = readableModel(req, res, module);
    if (!modelName) return;
    const record = await prisma[modelName].findFirst({ where: await reachableWhere(req, module, modelName, { id: String(recordId) }) });
    if (!record) return res.status(404).json({ error: 'Record not found' });

    // Get formula fields for this module
    const fields = await require('../services/computedFields').definitions(prisma,module);

    const results = {};
    for (const field of fields) {
      await require('../services/computedFields').hydrate(prisma,module,[record],fields);
      const value = record['custom.'+field.fieldKey];
      results[field.fieldKey] = {
        name: field.name,
        value,
        returnType: field.returnType,
        formula: field.formula,
      };
    }

    res.json({ recordId, module, fields: results });
  } catch (err) { next(err); }
});

// BULK evaluate for a list view (multiple records)
router.post('/evaluate-bulk', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds } = req.body;

    const modelName = readableModel(req, res, module);
    if (!modelName) return;
    const ids = Array.isArray(recordIds) ? recordIds.slice(0, 500).map(String) : [];
    const records = await prisma[modelName].findMany({ where: await reachableWhere(req, module, modelName, { id: { in: ids } }) });
    const fields = await require('../services/computedFields').definitions(prisma,module);
    await require('../services/computedFields').hydrate(prisma,module,records,fields);

    const results = {};
    for (const record of records) {
      results[record.id] = {};
      for (const field of fields) {
        results[record.id][field.fieldKey] = record['custom.'+field.fieldKey];
      }
    }

    res.json({ module, fieldDefinitions: fields.map(f => ({ key: f.fieldKey, name: f.name, returnType: f.returnType })), values: results });
  } catch (err) { next(err); }
});

module.exports = router;
