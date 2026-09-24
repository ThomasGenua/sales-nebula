const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const { pickModelFields, columnsFrom } = require('../utils/modelFields');

const router = Router();

/**
 * The custom object in the path, if it exists and is not deleted. A record's
 * customObjectId has no foreign key, so nothing else refuses records for an
 * object that is not there.
 */
const liveObject = (prisma, id) => prisma.customObject.findFirst({ where: { id, deletedAt: null }, select: { id: true } });

// Columns the server sets on a record, which its values may not carry.
const SERVER_FIELDS = new Set(['id', 'customObjectId', 'objectId', 'data', 'ownerId', 'createdById', 'createdAt', 'updatedAt', 'deletedAt']);
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A record's own field values: the request's `data` object, or the body itself
 * from clients that post fields flat; null when neither is an object. The raw
 * body was stored as is, so a record's values could claim its id, object or
 * creator.
 */
function recordValues(body) {
  if (!isPlainObject(body)) return null;
  const values = body.data == null ? body : body.data;
  if (!isPlainObject(values)) return null;
  return Object.fromEntries(Object.entries(values).filter(([key]) => !SERVER_FIELDS.has(key)));
}

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
  try { const prisma = req.app.locals.prisma; const obj = await prisma.customObject.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { fields: { orderBy: { sortOrder: 'asc' } } } }); if (!obj) return res.status(404).json({ error: 'Not found' }); res.json(obj); } catch (err) { next(err); }
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
        // A field's options and position are its picklistValues (a list of
        // strings) and sortOrder. They were written as options and order,
        // which CustomObjectField does not have, so an object created with
        // fields failed.
        ...(fields?.length && {
          fields: { create: fields.map((f, i) => ({ label: f.label, apiName: f.apiName || f.label.replace(/\s+/g, '_') + '__c', type: f.type || 'Text', required: f.required || false, unique: f.unique || false, defaultValue: f.defaultValue || null, picklistValues: [].concat(f.options ?? []).map(String), sortOrder: i + 1 })) },
        }),
      },
      include: { fields: true },
    });
    await req.audit({ action: 'create', module: 'customObjects', recordId: obj.id, details: `Custom object: ${label}` });
    res.status(201).json(obj);
  } catch (err) { next(err); }
});

// The definition's own columns. The body went to Prisma whole, so it could
// rewrite the id, creator and timestamps, or write into the object's fields
// and records.
router.put('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const data = columnsFrom('customObject', req.body); delete data.createdById; delete data.deletedAt; const obj = await prisma.customObject.update({ where: { id: req.params.id }, data }); res.json(obj); } catch (err) { next(err); }
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
    const { label, type, required, unique, defaultValue, options, lookupObject } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    if (!(await liveObject(prisma, req.params.id))) return res.status(404).json({ error: 'Not found' });
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
        // A list of strings, as create above writes them. This stored the
        // options JSON-encoded, as one option named `["a","b"]`.
        picklistValues: options == null ? undefined : [].concat(options).map(String),
        // What a Lookup field points at, which /relationships reports.
        lookupObject: lookupObject ? String(lookupObject) : null,
        sortOrder: (maxOrder._max.sortOrder || 0) + 1,
      },
    });
    res.status(201).json(field);
  } catch (err) { next(err); }
});

// Only a field of the object in the path. The field id alone reached any
// object's fields, whatever object the URL named.
router.put('/:id/fields/:fieldId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { data } = pickModelFields('customObjectField', req.body); delete data.id; delete data.objectId;
    const found = await prisma.customObjectField.findFirst({ where: { id: req.params.fieldId, objectId: req.params.id }, select: { id: true } });
    if (!found) return res.status(404).json({ error: 'Not found' });
    const field = await prisma.customObjectField.update({ where: { id: found.id }, data });
    res.json(field);
  } catch (err) { next(err); }
});

// Only a field of the object in the path, as for the update above.
router.delete('/:id/fields/:fieldId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const { count } = await req.app.locals.prisma.customObjectField.deleteMany({ where: { id: req.params.fieldId, objectId: req.params.id } });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Records CRUD (dynamic data stored as JSON)
// Objects are defined under admin, and there is no per-object permission, so
// their records answer to admin too: read to look, edit to change. These took
// a session alone.
router.get('/:id/records', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
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

router.post('/:id/records', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const values = recordValues(req.body);
    if (!values) return res.status(400).json({ error: 'data must be an object' });
    if (!(await liveObject(prisma, req.params.id))) return res.status(404).json({ error: 'Not found' });
    const record = await prisma.customRecord.create({
      data: { customObjectId: req.params.id, data: values, createdById: req.user.id },
    });
    res.status(201).json(record);
  } catch (err) { next(err); }
});

router.put('/:id/records/:recordId', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const values = recordValues(req.body);
    if (!values) return res.status(400).json({ error: 'data must be an object' });
    // Only a live record of the object in the path. The record id alone
    // reached any object's records, whatever object the URL named.
    const found = await prisma.customRecord.findFirst({ where: { id: req.params.recordId, customObjectId: req.params.id, deletedAt: null }, select: { id: true } });
    if (!found) return res.status(404).json({ error: 'Not found' });
    const record = await prisma.customRecord.update({ where: { id: found.id }, data: { data: values } });
    res.json(record);
  } catch (err) { next(err); }
});

// Only a live record of the object in the path, as for the update above.
router.delete('/:id/records/:recordId', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const { count } = await req.app.locals.prisma.customRecord.updateMany({ where: { id: req.params.recordId, customObjectId: req.params.id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
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
// In CustomRecord, where list, create, edit and delete keep them. This read
// CustomObjectRecord, which only the import wrote, so it never found a
// record made any other way. Values are matched here, among the latest 1000:
// `string_contains` with no path only matches a JSON value that is itself a
// string, and a record's data is an object, so the query matched nothing.
router.get('/:id/records/search', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, limit = 25 } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const needle = String(q).toLowerCase();
    const scanned = await prisma.customRecord.findMany({
      where: { customObjectId: req.params.id, deletedAt: null },
      take: 1000, orderBy: { createdAt: 'desc' },
    });
    const records = scanned
      .filter(r => isPlainObject(r.data) && Object.values(r.data).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(needle)))
      .slice(0, Math.min(+limit || 25, 200));
    res.json({ query: q, results: records, count: records.length });
  } catch (err) { next(err); }
});

// Custom object relationships
router.get('/:id/relationships', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const obj = await prisma.customObject.findUnique({ where: { id: req.params.id }, include: { fields: true } });
    if (!obj) return res.status(404).json({ error: 'Not found' });
    // Field types are stored as given ("Lookup"), and the target is
    // lookupObject; this matched lowercase only and read a relatedTo column
    // the field does not have, so no relationship was ever reported.
    const lookupFields = (obj.fields || []).filter(f => ['lookup', 'masterdetail'].includes(String(f.type).toLowerCase()));
    res.json({ objectId: obj.id, label: obj.label, relationships: lookupFields.map(f => ({ fieldName: f.apiName, relatedTo: f.lookupObject, type: f.type })) });
  } catch (err) { next(err); }
});

// Validate record against schema
router.post('/:id/records/validate', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const obj = await prisma.customObject.findUnique({ where: { id: req.params.id }, include: { fields: true } });
    if (!obj) return res.status(404).json({ error: 'Not found' });
    // No data was a 500, and the type check looked for "number" where fields
    // are stored as "Number", so no value was ever checked.
    const data = recordValues(req.body) || {};
    const errors = [];
    for (const field of obj.fields || []) {
      const value = data[field.apiName];
      const empty = value === undefined || value === null || value === '';
      if (field.required && empty) errors.push({ field: field.apiName, error: `${field.label || field.apiName} is required` });
      if (['number', 'currency'].includes(String(field.type).toLowerCase()) && !empty && isNaN(value)) errors.push({ field: field.apiName, error: `${field.label} must be a number` });
    }
    res.json({ valid: errors.length === 0, errors });
  } catch (err) { next(err); }
});

// Bulk import records
// Into CustomRecord, as create does. This wrote CustomObjectRecord, so an
// imported record never showed in the list and could not be edited or
// deleted.
router.post('/:id/records/import', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { records } = req.body;
    if (!records?.length) return res.status(400).json({ error: 'records required' });
    if (!(await liveObject(prisma, req.params.id))) return res.status(404).json({ error: 'Not found' });
    let created = 0, errors = 0;
    for (const rec of records.slice(0, 500)) {
      try {
        const values = recordValues(rec);
        if (!values) { errors++; continue; }
        await prisma.customRecord.create({ data: { customObjectId: req.params.id, data: values, createdById: req.user.id } });
        created++;
      } catch (e) { errors++; }
    }
    res.json({ imported: created, errors, total: records.length });
  } catch (err) { next(err); }
});
