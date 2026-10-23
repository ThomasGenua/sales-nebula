const TYPES = new Set(['text', 'textarea', 'richtext', 'phone', 'email', 'url', 'number', 'currency', 'percent', 'date', 'datetime', 'checkbox', 'picklist', 'lookup', 'masterdetail']);

function normalizeValues(fields, input, { defaults = false } = {}) {
  const data = {};
  const errors = [];
  const known = new Set(fields.map(f => f.apiName));
  for (const key of Object.keys(input)) if (!known.has(key)) errors.push({ field: key, error: 'Unknown field' });
  for (const field of fields) {
    const key = field.apiName;
    const type = String(field.type).toLowerCase();
    let value = input[key];
    if (value === undefined && defaults && field.defaultValue != null) value = field.defaultValue;
    const fail = error => errors.push({ field: key, error });
    if (value === undefined || value === null || value === '') {
      if (field.required) fail(`${field.label} is required`);
      if (value !== undefined) data[key] = null;
      continue;
    }
    if (!TYPES.has(type)) { fail(`Unsupported field type: ${field.type}`); continue; }
    if (['number', 'currency', 'percent'].includes(type)) {
      if (!['string', 'number'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value))) fail(`${field.label} must be a finite number`);
      else {
        value = Number(value);
        if (field.scale != null && Math.abs(value * 10 ** field.scale - Math.round(value * 10 ** field.scale)) > 1e-7) fail(`Use at most ${field.scale} decimal places`);
      }
    } else if (type === 'checkbox') {
      if (value === 'true') value = true;
      if (value === 'false') value = false;
      if (typeof value !== 'boolean') fail(`${field.label} must be true or false`);
    } else if (typeof value !== 'string') fail(`${field.label} must be text`);
    else {
      if (field.length && value.length > field.length) fail(`Maximum length is ${field.length}`);
      if (type === 'picklist' && !(field.picklistValues || []).includes(value)) fail('Choose an allowed option');
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('Enter a valid email address');
      if (type === 'url') {
        try { if (!['https:', 'http:'].includes(new URL(value).protocol)) fail('Use an HTTP or HTTPS URL'); } catch { fail('Enter a valid URL'); }
      }
      if (['date', 'datetime'].includes(type)) {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime()) || (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || parsed.toISOString().slice(0, 10) !== value))) fail('Enter a valid date');
        else value = type === 'date' ? value : parsed.toISOString();
      }
    }
    data[key] = value;
  }
  return { data, errors, valid: !errors.length };
}

async function validateValues(db, object, input, options = {}) {
  const result = normalizeValues(object.fields, input, options);
  for (const field of object.fields) {
    const value = result.data[field.apiName];
    if (value == null || result.errors.some(e => e.field === field.apiName)) continue;
    if (field.unique) {
      const duplicate = await db.customRecord.findFirst({ where: {
        customObjectId: object.id, deletedAt: null,
        ...(options.excludeId && { id: { not: options.excludeId } }),
        data: { path: [field.apiName], equals: value },
      }, select: { id: true } });
      if (duplicate) result.errors.push({ field: field.apiName, error: `${field.label} must be unique` });
    }
    if (['lookup', 'masterdetail'].includes(String(field.type).toLowerCase())) {
      const target = await db.customObject.findFirst({ where: { deletedAt: null, OR: [{ id: field.lookupObject || '' }, { apiName: field.lookupObject || '' }] }, select: { id: true } });
      const record = target && await db.customRecord.findFirst({ where: { id: value, customObjectId: target.id, deletedAt: null }, select: { id: true } });
      if (!record) result.errors.push({ field: field.apiName, error: 'Choose a live record of the related object' });
    }
  }
  result.valid = !result.errors.length;
  return result;
}

// Serialize saves for each definition, so concurrent creates cannot both pass
// a unique-value check. The lock also coordinates updates with imports.
async function saveValuesInTransaction(db, objectId, input, userId, recordId) {
    await db.$queryRaw`SELECT id FROM "CustomObject" WHERE id = ${objectId} FOR UPDATE`;
    const object = await db.customObject.findFirst({ where: { id: objectId, deletedAt: null }, include: { fields: true } });
    if (!object) return { status: 404, error: 'Object not found' };
    const actor = userId && await db.user.findUnique({ where: { id: userId }, include: { role: { include: { permissions: true } } } });
    for (const field of object.fields.filter(f => ['lookup', 'masterdetail'].includes(String(f.type).toLowerCase()))) {
      if (!input[field.apiName]) continue;
      const target = await db.customObject.findFirst({ where: { deletedAt: null, OR: [{ id: field.lookupObject || '' }, { apiName: field.lookupObject || '' }] } });
      if (!target || !require('./customObjectAccess').canAccess({ user: actor }, target.id)) return { status: 400, error: 'Choose a related object you can access' };
    }
    const old = recordId && await db.customRecord.findFirst({ where: { id: recordId, customObjectId: objectId, deletedAt: null } });
    if (recordId && !old) return { status: 404, error: 'Record not found' };
    const result = await validateValues(db, object, { ...Object.fromEntries(Object.entries(old?.data || {}).filter(([key]) => object.fields.some(f => f.apiName === key))), ...input }, { defaults: !old, excludeId: recordId });
    if (!result.valid) return { status: 400, error: 'Invalid field values', errors: result.errors };
    const record = old
      ? await db.customRecord.update({ where: { id: old.id }, data: { data: result.data } })
      : await db.customRecord.create({ data: { customObjectId: objectId, data: result.data, createdById: userId } });
    return { record, oldRecord: old || null };
}
async function saveValues(prisma, objectId, input, userId, recordId) {
  const result = await prisma.$transaction(db => saveValuesInTransaction(db, objectId, input, userId, recordId));
  if (result.record) await require('./flowEngine').triggerFlows(prisma, { module: 'custom:' + objectId, trigger: recordId ? 'update' : 'create', record: { ...result.record.data, id: result.record.id }, oldRecord: result.oldRecord ? { ...result.oldRecord.data, id: result.oldRecord.id } : null, userId });
  return result;
}

module.exports = { TYPES, normalizeValues, validateValues, saveValues, saveValuesInTransaction };
