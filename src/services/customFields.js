const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const { permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { evaluateConditions } = require('./workflowEngine');
const SUPPORTED = ['text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'picklist', 'multiselect', 'url', 'email', 'phone'];
const fail = message => Object.assign(new Error(message), { status: 400 });
const modelFor = module => require('../utils/crud').crudModelFor(module) || ({ quotes: 'quote', invoices: 'invoice', projects: 'project', prospects: 'prospect' })[module];
async function definitions(db, module) {
  const fields = await db.customFieldDef.findMany({ where: { module, active: true, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  const lists = await db.picklistValue.findMany({ where: { picklistId: { in: fields.map(f => f.picklistId).filter(Boolean) }, active: true }, orderBy: { sortOrder: 'asc' } });
  return fields.map(f => ({ ...f, supported: SUPPORTED.includes(f.fieldType), options: lists.filter(v => v.picklistId === f.picklistId).map(v => ({ value: v.value, label: v.label })) }));
}
async function accessibleRecord(req, module, id, level = 'read') {
  const model = modelFor(module);
  const permissionModule = module === 'prospects' ? 'leads' : module;
  if (!model || !permits(req, permissionModule, level)) throw Object.assign(new Error('Insufficient permissions'), { status: 403 });
  const record = await req.app.locals.prisma[model].findFirst({ where: await reachableWhere(req, permissionModule, model, { id }, level === 'read' ? 'Read' : 'Edit') });
  if (!record) throw Object.assign(new Error('Record not found'), { status: 404 });
  return record;
}
function normalize(field, input) {
  if (input === null || input === '' || input === undefined) {
    if (field.required) throw fail(field.label + ' is required');
    return null;
  }
  if (!SUPPORTED.includes(field.fieldType)) throw fail(field.label + ': this field type is not supported for values');
  let value = input;
  if (['number', 'currency', 'percent'].includes(field.fieldType)) {
    if (typeof input === 'boolean' || typeof input === 'object' || !Number.isFinite(Number(input))) throw fail(field.label + ' must be a number');
    value = Number(input);
    if (field.minValue != null && value < field.minValue || field.maxValue != null && value > field.maxValue) throw fail(field.label + ' is outside its allowed range');
  } else if (field.fieldType === 'boolean') {
    if (![true, false, 'true', 'false', '1', '0', 'yes', 'no'].includes(input)) throw fail(field.label + ' must be yes or no');
    value = [true, 'true', '1', 'yes'].includes(input);
  } else if (['date', 'datetime'].includes(field.fieldType)) {
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(input) || !Number.isFinite(Date.parse(input))) throw fail(field.label + ' must be a valid date');
    value = new Date(input).toISOString();
    if (field.fieldType === 'date') { value = value.slice(0, 10); if (value !== input.slice(0, 10)) throw fail(field.label + ' must be a valid date'); }
  } else if (field.fieldType === 'multiselect') {
    if (typeof input === 'string') { try { value = JSON.parse(input); } catch { value = input.split(';').map(v => v.trim()); } }
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !field.options.some(o => o.value === v))) throw fail(field.label + ' contains an invalid option');
    value = [...new Set(value)].sort();
    if (field.required && !value.length) throw fail(field.label + ' is required');
  } else {
    if (typeof input !== 'string' && typeof input !== 'number') throw fail(field.label + ' must be text');
    value = String(input).trim();
    if (field.required && !value) throw fail(field.label + ' is required');
    if (value.length > (field.maxLength || 10000)) throw fail(field.label + ' is too long');
    if (field.fieldType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw fail(field.label + ' must be an email address');
    if (field.fieldType === 'url') { try { if (!['https:', 'http:'].includes(new URL(value).protocol)) throw 0; } catch { throw fail(field.label + ' must be an HTTP or HTTPS URL'); } }
    if (field.fieldType === 'picklist' && !field.options.some(o => o.value === value)) throw fail(field.label + ' contains an invalid option');
    if (field.regex && !new RegExp(field.regex).test(value)) throw fail(field.regexMessage || field.label + ' has an invalid format');
  }
  return value;
}
async function prepareValues(db, module, input, recordId, { useDefaults = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Custom values must be an object keyed by field name');
  const fields = await definitions(db, module);
  for (const key of Object.keys(input)) if (!fields.some(f => f.name === key)) throw fail('Unknown custom field: ' + key);
  const existing = recordId ? await db.studioFieldValue.findMany({ where: { module, recordId } }) : [];
  const changes = [];
  for (const field of fields.filter(f => f.supported)) {
    const old = existing.find(v => v.fieldId === field.id);
    const supplied = Object.hasOwn(input, field.name);
    if (supplied && field.readOnly) {
      if (JSON.stringify(input[field.name]) !== JSON.stringify(old?.value ?? null)) throw fail(field.label + ' is read only');
      continue;
    }
    const candidate = supplied ? input[field.name] : old ? old.value : useDefaults ? field.defaultValue : null;
    // Required values are checked on a custom-field save or import, including false and zero.
    const value = normalize(field, candidate);
    if (supplied || (!old && useDefaults && value !== null)) changes.push({ fieldId: field.id, module, recordId, value: value === null ? Prisma.JsonNull : value,
      uniqueKey: field.unique && value !== null ? field.id + ':' + crypto.createHash('sha256').update(JSON.stringify(value).toLowerCase()).digest('hex') : null });
  }
  return changes;
}
async function saveValues(db, changes, recordId) {
  for (const data of changes) await db.studioFieldValue.upsert({ where: { fieldId_recordId: { fieldId: data.fieldId, recordId } }, create: { ...data, recordId }, update: { value: data.value, uniqueKey: data.uniqueKey } });
}
async function hydrate(db, module, rows) {
  const fields = await definitions(db, module);
  const values = rows.length ? await db.studioFieldValue.findMany({ where: { module, recordId: { in: rows.map(r => r.id) }, fieldId: { in: fields.map(f => f.id) } } }) : [];
  for (const row of rows) for (const field of fields) row['custom.' + field.name] = values.find(v => v.recordId === row.id && v.fieldId === field.id)?.value ?? null;
  return rows;
}
// Results are intersected with normal row security by the caller.
async function filterWhere(db, module, filters) {
  const custom = filters.filter(f => f.field?.startsWith('custom.'));
  if (!custom.length) return {};
  const fields = await definitions(db, module);
  let ids = null;
  for (const filter of custom) {
    const field = fields.find(f => 'custom.' + f.name === filter.field);
    if (!field) throw fail('Unknown custom field');
    const values = await db.studioFieldValue.findMany({ where: { module, fieldId: field.id } });
    const matched = values.filter(v => evaluateConditions([{ field: 'value', operator: filter.operator || 'equals', value: filter.value }], { value: v.value })).map(v => v.recordId);
    ids = ids === null ? matched : ids.filter(id => matched.includes(id));
  }
  return { id: { in: ids || [] } };
}
module.exports = { SUPPORTED, modelFor, definitions, accessibleRecord, normalize, prepareValues, saveValues, hydrate, filterWhere };
