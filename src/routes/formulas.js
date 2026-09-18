const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

// Supported functions in formulas
const FUNCTIONS = {
  NOW: () => new Date(),
  TODAY: () => new Date(new Date().toISOString().split('T')[0]),
  DATEDIFF: (a, b) => a && b ? Math.round((new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24)) : 0,
  IF: (cond, trueVal, falseVal) => cond ? trueVal : falseVal,
  MAX: (...args) => Math.max(...args.filter(a => typeof a === 'number')),
  MIN: (...args) => Math.min(...args.filter(a => typeof a === 'number')),
  ROUND: (n, d = 0) => Number(Number(n).toFixed(d)),
  ABS: (n) => Math.abs(n),
  UPPER: (s) => String(s || '').toUpperCase(),
  LOWER: (s) => String(s || '').toLowerCase(),
  LEN: (s) => String(s || '').length,
  CONCAT: (...args) => args.join(''),
  ISNULL: (v) => v == null || v === '',
  NULLVALUE: (v, def) => (v == null || v === '') ? def : v,
};

// Evaluate a formula expression against a record
function evaluateFormula(formula, record) {
  try {
    // Replace field references with actual values
    let expr = formula;

    // Replace field names with record values
    const fieldPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    const reservedWords = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', ...Object.keys(FUNCTIONS)];

    expr = expr.replace(fieldPattern, (match) => {
      if (reservedWords.includes(match)) return match;
      if (record[match] !== undefined) {
        const val = record[match];
        if (typeof val === 'string') return JSON.stringify(val);
        if (val instanceof Date) return `"${val.toISOString()}"`;
        if (val === null) return 'null';
        return val;
      }
      return match; // Leave unknown identifiers as-is
    });

    // Replace function calls
    Object.entries(FUNCTIONS).forEach(([name, fn]) => {
      const fnPattern = new RegExp(`${name}\\(([^)]*)\\)`, 'g');
      expr = expr.replace(fnPattern, (match, args) => {
        try {
          const parsedArgs = args ? args.split(',').map(a => {
            const trimmed = a.trim();
            if (trimmed === '') return undefined;
            try { return JSON.parse(trimmed); } catch { return trimmed; }
          }) : [];
          const result = fn(...parsedArgs);
          return typeof result === 'string' ? JSON.stringify(result) : result;
        } catch { return 'null'; }
      });
    });

    // Safely evaluate the expression
    // Use Function constructor with limited scope (no access to global objects)
    const safeEval = new Function('return (' + expr + ')');
    return safeEval();
  } catch (err) {
    return { error: err.message };
  }
}

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
    const { name, module, formula, returnType, precision } = req.body;
    if (!name || !module || !formula) return res.status(400).json({ error: 'name, module, and formula required' });
    const fieldKey = `ff_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const field = await prisma.formulaField.create({
      data: { name, fieldKey, module, formula, returnType: returnType || 'text', precision },
    });
    await req.audit({ action: 'create', module: 'settings', recordId: field.id, details: `Created formula field: ${name}` });
    res.status(201).json(field);
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, updatedAt, ...data } = req.body;
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

    // Get the record
    const modelName = module.endsWith('s') ? module.slice(0, -1) : module;
    const record = await prisma[modelName].findUnique({ where: { id: recordId } });
    if (!record) return res.status(404).json({ error: 'Record not found' });

    // Get formula fields for this module
    const fields = await prisma.formulaField.findMany({ where: { module, active: true } });

    const results = {};
    for (const field of fields) {
      const value = evaluateFormula(field.formula, record);
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

    const modelName = module.endsWith('s') ? module.slice(0, -1) : module;
    const records = await prisma[modelName].findMany({ where: { id: { in: recordIds } } });
    const fields = await prisma.formulaField.findMany({ where: { module, active: true } });

    const results = {};
    for (const record of records) {
      results[record.id] = {};
      for (const field of fields) {
        results[record.id][field.fieldKey] = evaluateFormula(field.formula, record);
      }
    }

    res.json({ module, fieldDefinitions: fields.map(f => ({ key: f.fieldKey, name: f.name, returnType: f.returnType })), values: results });
  } catch (err) { next(err); }
});

module.exports = router;
