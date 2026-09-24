const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { columnsFrom } = require('../utils/modelFields');

const router = Router();

const STUDIO_MODULES = [
  'contacts', 'leads', 'deals', 'accounts', 'cases', 'activities',
  'quotes', 'invoices', 'contracts', 'orders', 'products', 'campaigns',
  'projects', 'assets', 'subscriptions', 'prospects',
];

const FIELD_TYPES = {
  text:        { storage: 'valueText', label: 'Text' },
  textarea:    { storage: 'valueText', label: 'Long Text' },
  number:      { storage: 'valueNumber', label: 'Number' },
  currency:    { storage: 'valueNumber', label: 'Currency' },
  percent:     { storage: 'valueNumber', label: 'Percent' },
  date:        { storage: 'valueDate', label: 'Date' },
  datetime:    { storage: 'valueDate', label: 'Date/Time' },
  boolean:     { storage: 'valueBool', label: 'Checkbox' },
  picklist:    { storage: 'valueText', label: 'Dropdown' },
  multiselect: { storage: 'valueJson', label: 'Multi-Select' },
  url:         { storage: 'valueText', label: 'URL' },
  email:       { storage: 'valueText', label: 'Email' },
  phone:       { storage: 'valueText', label: 'Phone' },
  relate:      { storage: 'valueText', label: 'Related Record' },
  formula:     { storage: 'valueText', label: 'Formula' },
};

const RESERVED_NAMES = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'ownerId', 'name', 'type', 'status']);

/** Normalize a label into a safe storage key. */
function slugifyFieldName(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** Coerce and validate a value against a field definition. */
function coerceValue(field, raw) {
  const type = field.fieldType;
  if (raw === null || raw === undefined || raw === '') {
    if (field.required) return { error: `${field.label} is required` };
    return { value: null, column: FIELD_TYPES[type]?.storage || 'valueText' };
  }

  const column = FIELD_TYPES[type]?.storage || 'valueText';

  if (['number', 'currency', 'percent'].includes(type)) {
    const n = Number(raw);
    if (isNaN(n)) return { error: `${field.label} must be a number` };
    if (field.minValue != null && n < field.minValue) return { error: `${field.label} must be at least ${field.minValue}` };
    if (field.maxValue != null && n > field.maxValue) return { error: `${field.label} must be at most ${field.maxValue}` };
    return { value: +n.toFixed(field.precision ?? 2), column };
  }

  if (['date', 'datetime'].includes(type)) {
    const d = new Date(raw);
    if (isNaN(d)) return { error: `${field.label} must be a valid date` };
    return { value: d, column };
  }

  if (type === 'boolean') return { value: raw === true || raw === 'true' || raw === 1 || raw === '1', column };

  if (type === 'multiselect') {
    const list = Array.isArray(raw) ? raw : String(raw).split(',').map(s => s.trim()).filter(Boolean);
    return { value: list, column };
  }

  const str = String(raw);
  if (field.maxLength && str.length > field.maxLength) return { error: `${field.label} exceeds ${field.maxLength} characters` };
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) return { error: `${field.label} must be a valid email address` };
  if (type === 'url' && !/^https?:\/\/.+/.test(str)) return { error: `${field.label} must start with http:// or https://` };
  if (field.regex) {
    try {
      if (!new RegExp(field.regex).test(str)) return { error: field.regexMessage || `${field.label} does not match the required format` };
    } catch { /* an invalid stored pattern should not block the save */ }
  }
  return { value: str, column };
}

/** Evaluate one validation rule condition against a record. */
function evaluateCondition(condition, record) {
  const actual = record?.[condition.field];
  const expected = condition.value;
  switch (condition.operator) {
    case 'equals': return String(actual) === String(expected);
    case 'notEquals': return String(actual) !== String(expected);
    case 'contains': return String(actual || '').toLowerCase().includes(String(expected).toLowerCase());
    case 'notContains': return !String(actual || '').toLowerCase().includes(String(expected).toLowerCase());
    case 'startsWith': return String(actual || '').toLowerCase().startsWith(String(expected).toLowerCase());
    case 'greaterThan': return Number(actual) > Number(expected);
    case 'lessThan': return Number(actual) < Number(expected);
    case 'greaterOrEqual': return Number(actual) >= Number(expected);
    case 'lessOrEqual': return Number(actual) <= Number(expected);
    case 'isEmpty': return actual === null || actual === undefined || actual === '';
    case 'isNotEmpty': return actual !== null && actual !== undefined && actual !== '';
    case 'in': return Array.isArray(expected) && expected.map(String).includes(String(actual));
    case 'notIn': return Array.isArray(expected) && !expected.map(String).includes(String(actual));
    case 'changed': return true; // resolved by the caller comparing snapshots
    default: return false;
  }
}

/** Run a rule's condition set, honouring AND/OR conjunctions. */
function evaluateRule(rule, record) {
  const raw = rule.conditions ?? rule.condition;
  const conditions = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!conditions.length) return false;

  let result = evaluateCondition(conditions[0], record);
  for (let i = 1; i < conditions.length; i++) {
    const c = conditions[i];
    const value = evaluateCondition(c, record);
    result = (c.conjunction || 'AND').toUpperCase() === 'OR' ? result || value : result && value;
  }
  return result;
}

// ── CUSTOM FIELDS ─────────────────────────────────────────────────────

router.get('/fields/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { module: req.params.module, deletedAt: null };
    if (req.query.active !== 'false') where.active = true;

    const fields = await prisma.customFieldDef.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });

    // Attach picklist values so the UI can render dropdowns in one call
    const picklistIds = [...new Set(fields.map(f => f.picklistId).filter(Boolean))];
    const picklists = picklistIds.length
      ? await prisma.picklist.findMany({ where: { id: { in: picklistIds } }, include: { values: { where: { active: true }, orderBy: { sortOrder: 'asc' } } } })
      : [];
    const byId = new Map(picklists.map(p => [p.id, p]));

    res.json(fields.map(f => ({ ...f, picklist: f.picklistId ? byId.get(f.picklistId) || null : null, storage: FIELD_TYPES[f.fieldType]?.storage })));
  } catch (err) { next(err); }
});

router.post('/fields', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, label, fieldType, name, description, helpText, required, defaultValue, maxLength, minValue, maxValue, precision, picklistId, relatedModule, regex, regexMessage, searchable, auditable, readOnly, sortOrder } = req.body;

    if (!module || !STUDIO_MODULES.includes(module)) return res.status(400).json({ error: `module must be one of: ${STUDIO_MODULES.join(', ')}` });
    if (!label) return res.status(400).json({ error: 'label required' });
    if (!fieldType || !FIELD_TYPES[fieldType]) return res.status(400).json({ error: `fieldType must be one of: ${Object.keys(FIELD_TYPES).join(', ')}` });

    const key = name ? slugifyFieldName(name) : slugifyFieldName(label);
    if (!key) return res.status(400).json({ error: 'Could not derive a valid field name from the label' });
    if (RESERVED_NAMES.has(key)) return res.status(400).json({ error: `"${key}" is a reserved field name` });

    const dupe = await prisma.customFieldDef.findFirst({ where: { module, name: key, deletedAt: null } });
    if (dupe) return res.status(409).json({ error: `A field named "${key}" already exists on ${module}` });

    if (fieldType === 'picklist' || fieldType === 'multiselect') {
      if (!picklistId) return res.status(400).json({ error: `${fieldType} fields need a picklistId` });
      const pl = await prisma.picklist.findFirst({ where: { id: picklistId, deletedAt: null } });
      if (!pl) return res.status(400).json({ error: 'picklistId not found' });
    }
    if (fieldType === 'relate' && !relatedModule) return res.status(400).json({ error: 'relate fields need a relatedModule' });
    if (regex) { try { new RegExp(regex); } catch { return res.status(400).json({ error: 'regex is not a valid pattern' }); } }

    let order = sortOrder;
    if (order == null) {
      const last = await prisma.customFieldDef.findFirst({ where: { module }, orderBy: { sortOrder: 'desc' } });
      order = (last?.sortOrder ?? -1) + 1;
    }

    const field = await prisma.customFieldDef.create({
      data: {
        module, name: key, label, fieldType, description, helpText,
        required: !!required, defaultValue, maxLength: maxLength ? +maxLength : null,
        minValue: minValue != null ? +minValue : null, maxValue: maxValue != null ? +maxValue : null,
        precision: precision != null ? +precision : 2,
        picklistId: picklistId || null, relatedModule: relatedModule || null,
        regex: regex || null, regexMessage: regexMessage || null,
        searchable: !!searchable, auditable: !!auditable, readOnly: !!readOnly,
        sortOrder: order, createdById: req.user.id,
      },
    });

    await req.audit({ action: 'create', module: 'studio', recordId: field.id, details: `Custom field created: ${module}.${key}` });
    res.status(201).json(field);
  } catch (err) { next(err); }
});

router.put('/fields/:id', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.customFieldDef.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!existing) return res.status(404).json({ error: 'Field not found' });

    const { module, name, picklist, storage, ...data } = columnsFrom('customFieldDef', req.body);

    // Changing type after data exists would strand values in the wrong column
    if (data.fieldType && data.fieldType !== existing.fieldType) {
      const valueCount = await prisma.customFieldValue.count({ where: { customFieldId: existing.id } });
      if (valueCount > 0) {
        return res.status(409).json({ error: `Cannot change field type: ${valueCount} records already hold a value. Create a new field instead.` });
      }
      if (!FIELD_TYPES[data.fieldType]) return res.status(400).json({ error: 'Invalid fieldType' });
    }
    if (data.regex) { try { new RegExp(data.regex); } catch { return res.status(400).json({ error: 'regex is not a valid pattern' }); } }

    const field = await prisma.customFieldDef.update({ where: { id: existing.id }, data });
    await req.audit({ action: 'update', module: 'studio', recordId: field.id, details: `Custom field updated: ${field.module}.${field.name}` });
    res.json(field);
  } catch (err) { next(err); }
});

router.delete('/fields/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const field = await prisma.customFieldDef.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!field) return res.status(404).json({ error: 'Field not found' });

    const valueCount = await prisma.customFieldValue.count({ where: { customFieldId: field.id } });
    if (valueCount > 0 && req.query.force !== 'true') {
      return res.status(409).json({ error: `${valueCount} records hold a value for this field. Pass force=true to delete the field and its data.`, valueCount });
    }
    if (req.query.force === 'true') await prisma.customFieldValue.deleteMany({ where: { customFieldId: field.id } });

    await prisma.customFieldDef.update({ where: { id: field.id }, data: { deletedAt: new Date(), active: false } });
    await req.audit({ action: 'delete', module: 'studio', recordId: field.id, details: `Custom field deleted: ${field.module}.${field.name}` });
    res.json({ deleted: true, valuesRemoved: req.query.force === 'true' ? valueCount : 0 });
  } catch (err) { next(err); }
});

router.post('/fields/reorder', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    let updated = 0;
    for (const [i, fieldId] of order.entries()) {
      await prisma.customFieldDef.update({ where: { id: fieldId }, data: { sortOrder: i } }).then(() => updated++).catch(() => {});
    }
    res.json({ updated });
  } catch (err) { next(err); }
});

router.get('/field-types', authenticate, async (req, res) => {
  res.json(Object.entries(FIELD_TYPES).map(([value, meta]) => ({ value, label: meta.label, storage: meta.storage })));
});

// ── CUSTOM FIELD VALUES ───────────────────────────────────────────────

router.get('/values/:module/:recordId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const fields = await prisma.customFieldDef.findMany({ where: { module: req.params.module, deletedAt: null, active: true }, orderBy: { sortOrder: 'asc' } });
    const values = await prisma.customFieldValue.findMany({ where: { module: req.params.module, recordId: req.params.recordId } });
    const byField = new Map(values.map(v => [v.fieldId, v]));

    res.json(fields.map(f => {
      const v = byField.get(f.id);
      const column = FIELD_TYPES[f.fieldType]?.storage || 'valueText';
      return {
        fieldId: f.id, name: f.name, label: f.label, fieldType: f.fieldType,
        required: f.required, readOnly: f.readOnly, helpText: f.helpText,
        value: v ? v[column] : (f.defaultValue ?? null),
        hasValue: !!v,
      };
    }));
  } catch (err) { next(err); }
});

router.put('/values/:module/:recordId', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { values } = req.body;
    if (!values || typeof values !== 'object') return res.status(400).json({ error: 'values object required' });

    const fields = await prisma.customFieldDef.findMany({ where: { module: req.params.module, deletedAt: null, active: true } });
    const byName = new Map(fields.map(f => [f.name, f]));

    const errors = [], saved = [];
    // Validate everything before writing anything
    const pending = [];
    for (const [name, raw] of Object.entries(values)) {
      const field = byName.get(name);
      if (!field) { errors.push(`Unknown field: ${name}`); continue; }
      if (field.readOnly) { errors.push(`${field.label} is read only`); continue; }
      const result = coerceValue(field, raw);
      if (result.error) { errors.push(result.error); continue; }
      pending.push({ field, ...result });
    }

    // Required fields with no value anywhere
    for (const f of fields.filter(x => x.required)) {
      if (Object.prototype.hasOwnProperty.call(values, f.name)) continue;
      const existing = await prisma.customFieldValue.findFirst({ where: { customFieldId: f.id, recordId: req.params.recordId } });
      if (!existing) errors.push(`${f.label} is required`);
    }

    if (errors.length) return res.status(400).json({ error: 'Validation failed', errors });

    for (const { field, value, column } of pending) {
      const data = { valueText: null, valueNumber: null, valueDate: null, valueBool: null, valueJson: null, [column]: value };
      const existing = await prisma.customFieldValue.findFirst({ where: { customFieldId: field.id, recordId: req.params.recordId } });
      if (existing) await prisma.customFieldValue.update({ where: { id: existing.id }, data });
      else await prisma.customFieldValue.create({ data: { ...data, customFieldId: field.id, module: req.params.module, recordId: req.params.recordId } });
      saved.push(field.name);
    }

    await req.audit({ action: 'update', module: 'studio', recordId: req.params.recordId, details: `Custom fields updated: ${saved.join(', ')}` });
    res.json({ saved: saved.length, fields: saved });
  } catch (err) { next(err); }
});

// ── PICKLISTS ─────────────────────────────────────────────────────────

router.get('/picklists', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const picklists = await prisma.picklist.findMany({
      where: { deletedAt: null, ...(req.query.active !== 'false' && { active: true }) },
      include: { values: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { label: 'asc' },
    });
    res.json(picklists);
  } catch (err) { next(err); }
});

router.post('/picklists', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, label, description, values } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });

    const key = name ? slugifyFieldName(name) : slugifyFieldName(label);
    const dupe = await prisma.picklist.findFirst({ where: { name: key, deletedAt: null } });
    if (dupe) return res.status(409).json({ error: `A picklist named "${key}" already exists` });

    const picklist = await prisma.picklist.create({ data: { name: key, label, description } });
    for (const [i, v] of (values || []).entries()) {
      const value = typeof v === 'string' ? v : v.value;
      if (!value) continue;
      await prisma.picklistValue.create({
        data: {
          picklistId: picklist.id, value: String(value),
          label: typeof v === 'string' ? v : (v.label || value),
          color: typeof v === 'object' ? v.color : null,
          sortOrder: typeof v === 'object' ? (v.sortOrder ?? i) : i,
          isDefault: typeof v === 'object' ? !!v.isDefault : false,
        },
      }).catch(() => {});
    }

    const full = await prisma.picklist.findUnique({ where: { id: picklist.id }, include: { values: { orderBy: { sortOrder: 'asc' } } } });
    await req.audit({ action: 'create', module: 'studio', recordId: picklist.id, details: `Picklist created: ${label}` });
    res.status(201).json(full);
  } catch (err) { next(err); }
});

router.post('/picklists/:id/values', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { value, label, color, sortOrder, isDefault, parentValue } = req.body;
    if (!value) return res.status(400).json({ error: 'value required' });

    const picklist = await prisma.picklist.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!picklist) return res.status(404).json({ error: 'Picklist not found' });

    const dupe = await prisma.picklistValue.findFirst({ where: { picklistId: picklist.id, value } });
    if (dupe) return res.status(409).json({ error: `Value "${value}" already exists in this picklist` });

    if (isDefault) await prisma.picklistValue.updateMany({ where: { picklistId: picklist.id, isDefault: true }, data: { isDefault: false } });

    let order = sortOrder;
    if (order == null) {
      const last = await prisma.picklistValue.findFirst({ where: { picklistId: picklist.id }, orderBy: { sortOrder: 'desc' } });
      order = (last?.sortOrder ?? -1) + 1;
    }

    const created = await prisma.picklistValue.create({
      data: { picklistId: picklist.id, value, label: label || value, color, sortOrder: order, isDefault: !!isDefault, parentValue: parentValue || null },
    });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.delete('/picklists/values/:valueId', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const value = await prisma.picklistValue.findUnique({ where: { id: req.params.valueId } });
    if (!value) return res.status(404).json({ error: 'Picklist value not found' });

    // Deactivating rather than deleting keeps historical records readable
    const inUse = await prisma.customFieldValue.count({ where: { value: value.value } });
    if (inUse > 0 && req.query.force !== 'true') {
      await prisma.picklistValue.update({ where: { id: value.id }, data: { active: false } });
      return res.json({ deactivated: true, reason: `${inUse} records still use this value, so it was deactivated rather than deleted`, inUse });
    }
    await prisma.picklistValue.delete({ where: { id: value.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post('/picklists/:id/reorder', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    let updated = 0;
    for (const [i, valueId] of order.entries()) {
      await prisma.picklistValue.update({ where: { id: valueId }, data: { sortOrder: i } }).then(() => updated++).catch(() => {});
    }
    res.json({ updated });
  } catch (err) { next(err); }
});

// ── LAYOUTS ───────────────────────────────────────────────────────────

router.get('/layouts/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { module: req.params.module, active: true };
    if (req.query.viewType) where.viewType = req.query.viewType;
    const layouts = await prisma.layoutDef.findMany({ where, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    res.json(layouts);
  } catch (err) { next(err); }
});

router.post('/layouts', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, viewType, name, panels, isDefault, roleId } = req.body;
    if (!module || !STUDIO_MODULES.includes(module)) return res.status(400).json({ error: `Unsupported module: ${module}` });
    if (!Array.isArray(panels)) return res.status(400).json({ error: 'panels array required' });

    for (const panel of panels) {
      if (!Array.isArray(panel.fields)) return res.status(400).json({ error: 'Each panel needs a fields array' });
      if (panel.columns && ![1, 2, 3, 4].includes(panel.columns)) return res.status(400).json({ error: 'panel columns must be 1, 2, 3, or 4' });
    }

    const view = viewType || 'detail';
    const layoutName = name || 'Default';
    if (isDefault) await prisma.layoutDef.updateMany({ where: { module, viewType: view, isDefault: true }, data: { isDefault: false } });

    const existing = await prisma.layoutDef.findFirst({ where: { module, viewType: view, name: layoutName } });
    const layout = existing
      ? await prisma.layoutDef.update({ where: { id: existing.id }, data: { panels, isDefault: !!isDefault, roleId } })
      : await prisma.layoutDef.create({ data: { module, viewType: view, name: layoutName, panels, isDefault: !!isDefault, roleId } });

    await req.audit({ action: existing ? 'update' : 'create', module: 'studio', recordId: layout.id, details: `Layout saved: ${module}/${view}/${layoutName}` });
    res.status(existing ? 200 : 201).json(layout);
  } catch (err) { next(err); }
});

router.delete('/layouts/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.layoutDef.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── VALIDATION RULES ──────────────────────────────────────────────────

router.get('/rules/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.validationRule.findMany({ where: { module: req.params.module }, orderBy: { createdAt: 'asc' } });
    res.json(rules);
  } catch (err) { next(err); }
});

router.post('/rules', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, condition, conditions, errorMessage, errorField, description, active } = req.body;
    if (!name || !module) return res.status(400).json({ error: 'name and module required' });
    if (!errorMessage) return res.status(400).json({ error: 'errorMessage required' });

    const conds = conditions || condition;
    const list = Array.isArray(conds) ? conds : conds ? [conds] : [];
    if (!list.length) return res.status(400).json({ error: 'At least one condition is required' });

    const validOps = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual', 'isEmpty', 'isNotEmpty', 'in', 'notIn', 'changed'];
    for (const c of list) {
      if (!c.field) return res.status(400).json({ error: 'Each condition needs a field' });
      if (!validOps.includes(c.operator)) return res.status(400).json({ error: `Invalid operator "${c.operator}". Valid: ${validOps.join(', ')}` });
    }

    const rule = await prisma.validationRule.create({
      data: { name, module, condition: list, errorMessage, errorField, description, active: active !== false },
    });
    await req.audit({ action: 'create', module: 'studio', recordId: rule.id, details: `Validation rule created: ${name}` });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/rules/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.validationRule.update({ where: { id: req.params.id }, data: columnsFrom('validationRule', req.body) });
    res.json(rule);
  } catch (err) { next(err); }
});

router.delete('/rules/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.validationRule.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Run every active rule for a module against a candidate record
router.post('/rules/:module/evaluate', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { record } = req.body;
    if (!record) return res.status(400).json({ error: 'record object required' });

    const rules = await prisma.validationRule.findMany({ where: { module: req.params.module, active: true } });
    const violations = [];
    for (const rule of rules) {
      if (evaluateRule(rule, record)) {
        violations.push({ ruleId: rule.id, ruleName: rule.name, field: rule.errorField, message: rule.errorMessage });
      }
    }
    res.json({ valid: violations.length === 0, rulesEvaluated: rules.length, violations });
  } catch (err) { next(err); }
});

// Dry-run a rule against existing data
router.post('/rules/:id/test', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.validationRule.findUnique({ where: { id: req.params.id } });
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    const modelMap = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', quotes: 'quote', invoices: 'invoice', products: 'product', projects: 'project' };
    const model = modelMap[rule.module];
    if (!model) return res.status(400).json({ error: `Cannot test rules for module ${rule.module}` });

    const sample = await prisma[model].findMany({ where: { deletedAt: null }, take: 500 });
    const wouldFail = sample.filter(r => evaluateRule(rule, r));
    res.json({
      ruleId: rule.id, ruleName: rule.name,
      sampleSize: sample.length, wouldFail: wouldFail.length,
      failureRate: sample.length ? +((wouldFail.length / sample.length) * 100).toFixed(1) : 0,
      examples: wouldFail.slice(0, 10).map(r => ({ id: r.id, name: r.name || r.subject || `${r.firstName || ''} ${r.lastName || ''}`.trim() })),
    });
  } catch (err) { next(err); }
});

// ── OVERVIEW ──────────────────────────────────────────────────────────

router.get('/overview', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [fields, picklists, layouts, rules] = await Promise.all([
      prisma.customFieldDef.findMany({ where: { deletedAt: null }, select: { module: true, active: true, fieldType: true } }),
      prisma.picklist.count({ where: { deletedAt: null } }),
      prisma.layoutDef.count({ where: { active: true } }),
      prisma.validationRule.count({ where: { active: true } }),
    ]);

    const byModule = {};
    for (const m of STUDIO_MODULES) {
      const mine = fields.filter(f => f.module === m);
      if (mine.length) byModule[m] = { total: mine.length, active: mine.filter(f => f.active).length };
    }

    res.json({
      customFields: fields.length,
      activeCustomFields: fields.filter(f => f.active).length,
      picklists, layouts, validationRules: rules,
      modulesCustomized: Object.keys(byModule).length,
      byModule,
      byType: fields.reduce((a, f) => { a[f.fieldType] = (a[f.fieldType] || 0) + 1; return a; }, {}),
      availableModules: STUDIO_MODULES,
    });
  } catch (err) { next(err); }
});

module.exports = router;
