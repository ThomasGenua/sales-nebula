const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const { pickModelFields } = require('../utils/modelFields');

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search } = req.query;
    const where = { deletedAt: null };
    if (search) where.OR = [{ label: { contains: search, mode: 'insensitive' } }, { apiName: { contains: search, mode: 'insensitive' } }];
    const [data, total] = await Promise.all([prisma.customObject.findMany({ where, orderBy: { label: 'asc' }, take: +limit, skip: (+page - 1) * +limit }), prisma.customObject.count({ where })]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const obj = await prisma.customObject.findUnique({ where: { id: req.params.id }, include: { fields: { orderBy: { sortOrder: 'asc' } } } }); if (!obj) return res.status(404).json({ error: 'Not found' }); res.json(obj); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { label, apiName, pluralLabel, description, fields } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    const name = apiName || label.replace(/\s+/g, '_') + '__c';
    const existing = await prisma.customObject.findFirst({ where: { apiName: name } });
    if (existing) return res.status(409).json({ error: 'API name already exists' });
    const obj = await prisma.customObject.create({
      data: {
        label, apiName: name, pluralLabel: pluralLabel || `${label}s`, description, createdById: req.user.id,
        ...(fields?.length && {
          fields: { create: fields.map((f, i) => ({ label: f.label, apiName: f.apiName || f.label.replace(/\s+/g, '_') + '__c', type: f.type || 'Text', required: f.required || false, unique: f.unique || false, defaultValue: f.defaultValue || null, options: f.options || null, order: i + 1 })) },
        }),
      },
      include: { fields: true },
    });
    await req.audit({ action: 'create', module: 'customObjects', recordId: obj.id, details: `Custom object: ${label}` });
    res.status(201).json(obj);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const obj = await prisma.customObject.update({ where: { id: req.params.id }, data: req.body }); res.json(obj); } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try { await req.app.locals.prisma.customObject.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Fields CRUD
router.get('/:id/fields', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const fields = await prisma.customObjectField.findMany({ where: { objectId: req.params.id }, orderBy: { sortOrder: 'asc' } }); res.json(fields); } catch (err) { next(err); }
});

router.post('/:id/fields', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { label, type, required, unique, defaultValue, options } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    // A custom object's fields are CustomObjectField rows; this wrote them into
    // CustomField — the per-module field definitions — which has none of these
    // columns, so no field could ever be added to a custom object.
    const maxOrder = await prisma.customObjectField.aggregate({ where: { objectId: req.params.id }, _max: { sortOrder: true } });
    const field = await prisma.customObjectField.create({
      data: {
        objectId: req.params.id, label,
        apiName: label.replace(/\s+/g, '_') + '__c',
        type: type || 'Text', required: !!required, unique: !!unique,
        defaultValue: defaultValue === undefined || defaultValue === null ? null : String(defaultValue),
        picklistValues: options == null ? undefined : typeof options === 'string' ? options : JSON.stringify(options),
        sortOrder: (maxOrder._max.sortOrder || 0) + 1,
      },
    });
    res.status(201).json(field);
  } catch (err) { next(err); }
});

router.put('/:id/fields/:fieldId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const { data } = pickModelFields('customObjectField', req.body); delete data.id; delete data.objectId; const field = await prisma.customObjectField.update({ where: { id: req.params.fieldId }, data }); res.json(field); } catch (err) { next(err); }
});

router.delete('/:id/fields/:fieldId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.customObjectField.delete({ where: { id: req.params.fieldId } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Records CRUD (dynamic data stored as JSON)
router.get('/:id/records', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search } = req.query;
    const where = { customObjectId: req.params.id, deletedAt: null };
    const [data, total] = await Promise.all([
      prisma.customRecord.findMany({ where, orderBy: { createdAt: 'desc' }, take: +limit, skip: (+page - 1) * +limit }),
      prisma.customRecord.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

router.post('/:id/records', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const record = await prisma.customRecord.create({
      data: { customObjectId: req.params.id, data: req.body.data || req.body, createdById: req.user.id },
    });
    res.status(201).json(record);
  } catch (err) { next(err); }
});

router.put('/:id/records/:recordId', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const record = await prisma.customRecord.update({ where: { id: req.params.recordId }, data: { data: req.body.data || req.body } });
    res.json(record);
  } catch (err) { next(err); }
});

router.delete('/:id/records/:recordId', authenticate, async (req, res, next) => {
  try { await req.app.locals.prisma.customRecord.update({ where: { id: req.params.recordId }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Schema export
router.get('/:id/schema', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const obj = await prisma.customObject.findUnique({ where: { id: req.params.id }, include: { fields: { orderBy: { sortOrder: 'asc' } } } });
    if (!obj) return res.status(404).json({ error: 'Not found' });
    res.json({ objectName: obj.apiName, label: obj.label, fields: obj.fields.map(f => ({ name: f.apiName, label: f.label, type: f.type, required: f.required, unique: f.unique })) });
  } catch (err) { next(err); }
});

module.exports = router;

// Search records of a custom object
router.get('/:id/records/search', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, limit = 25 } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const records = await prisma.customObjectRecord.findMany({
      where: { objectId: req.params.id, data: { string_contains: q } },
      take: +limit, orderBy: { createdAt: 'desc' },
    });
    res.json({ query: q, results: records, count: records.length });
  } catch (err) { next(err); }
});

// Custom object relationships
router.get('/:id/relationships', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const obj = await prisma.customObject.findUnique({ where: { id: req.params.id }, include: { fields: true } });
    if (!obj) return res.status(404).json({ error: 'Not found' });
    const lookupFields = (obj.fields || []).filter(f => f.type === 'lookup' || f.type === 'masterDetail');
    res.json({ objectId: obj.id, label: obj.label, relationships: lookupFields.map(f => ({ fieldName: f.apiName, relatedTo: f.relatedTo, type: f.type })) });
  } catch (err) { next(err); }
});

// Validate record against schema
router.post('/:id/records/validate', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const obj = await prisma.customObject.findUnique({ where: { id: req.params.id }, include: { fields: true } });
    if (!obj) return res.status(404).json({ error: 'Not found' });
    const { data } = req.body;
    const errors = [];
    for (const field of obj.fields || []) {
      if (field.required && !data[field.apiName]) errors.push({ field: field.apiName, error: `${field.label || field.apiName} is required` });
      if (field.type === 'number' && data[field.apiName] && isNaN(data[field.apiName])) errors.push({ field: field.apiName, error: `${field.label} must be a number` });
    }
    res.json({ valid: errors.length === 0, errors });
  } catch (err) { next(err); }
});

// Bulk import records
router.post('/:id/records/import', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { records } = req.body;
    if (!records?.length) return res.status(400).json({ error: 'records required' });
    let created = 0, errors = 0;
    for (const rec of records.slice(0, 500)) {
      try {
        await prisma.customObjectRecord.create({ data: { objectId: req.params.id, data: rec, createdById: req.user.id } });
        created++;
      } catch (e) { errors++; }
    }
    res.json({ imported: created, errors, total: records.length });
  } catch (err) { next(err); }
});
