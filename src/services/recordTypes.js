const { isAdmin } = require('../middleware/rowSecurity');
const refuse = message => { throw Object.assign(new Error(message), { status: 400, code: 'RECORD_TYPE' }); };
const allowed = (type, user) => isAdmin(user) || !Array.isArray(type.roleIds) || !type.roleIds.length || type.roleIds.includes(user?.roleId);

async function metadata(db, module, user) {
  const types = await db.recordType.findMany({ where: { module, active: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  const accessible = types.filter(t => allowed(t, user));
  const layouts = await db.pageLayout.findMany({ where: { id: { in: accessible.map(t => t.layoutId).filter(Boolean) }, module, active: true } });
  return { recordTypes: accessible, layouts };
}

async function enforceRecordType(db, module, data, current, ctx) {
  if (!Object.values(require('./fieldSecurity').modelModules).includes(module)) return data;
  const user = ctx.req?.user || (ctx.userId ? await db.user.findUnique({ where: { id: ctx.userId }, include: { role: true } }) : null);
  const types = await db.recordType.findMany({ where: { module, active: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  let id = data.recordTypeId ?? current?.recordTypeId;
  if (!id && !current) id = types.find(t => t.isDefault && allowed(t, user))?.id;
  if (!id) {
    if (types.length && !current) refuse('Choose a record type');
    return data;
  }
  const type = types.find(t => t.id === id);
  if (!type || !allowed(type, user)) refuse('Record type is unavailable for this module or role');
  const { Prisma } = require('@prisma/client');
  const model = Prisma.dmmf.datamodel.models.find(m => require('./fieldSecurity').modelModules[m.name] === module);
  const defaults = Object.fromEntries((model?.fields || []).filter(f => f.hasDefaultValue && ['string', 'number', 'boolean'].includes(typeof f.default)).map(f => [f.name, f.default]));
  const merged = { ...defaults, ...current, ...data, recordTypeId: id };
  for (const [field, values] of Object.entries(type.allowedValues || {})) {
    if (!Array.isArray(values) || !values.length) continue;
    if (merged[field] != null && merged[field] !== '' && !values.includes(merged[field])) refuse(`${field} is not allowed for ${type.name}`);
  }
  if (type.layoutId) {
    const layout = await db.pageLayout.findFirst({ where: { id: type.layoutId, module, active: true } });
    if (!layout) refuse('The assigned layout is unavailable');
    for (const section of layout.sections || []) for (const field of section.fields || []) {
      const value = merged[field.name];
      if (field.required && (value == null || value === '' || Array.isArray(value) && !value.length)) refuse(`${field.name} is required by ${layout.name}`);
      const authored = ctx.authored || data;
      if (field.readOnly && Object.hasOwn(authored, field.name) && JSON.stringify(authored[field.name]) !== JSON.stringify(current?.[field.name])) refuse(`${field.name} is read only in ${layout.name}`);
    }
  }
  return { ...data, recordTypeId: id };
}
module.exports = { allowed, metadata, enforceRecordType };

async function validateConfiguration(db, table, input) {
  const { Prisma } = require('@prisma/client');
  const { modelModules } = require('./fieldSecurity');
  const model = Prisma.dmmf.datamodel.models.find(m => modelModules[m.name] === input.module);
  if (!model || typeof input.name !== 'string' || !input.name.trim()) refuse('Choose a supported module and a name');
  const fieldNames = new Set(model.fields.filter(f => f.kind !== 'object').map(f => f.name));
  if (table === 'recordType') {
    if (input.roleIds != null && (!Array.isArray(input.roleIds) || input.roleIds.some(id => typeof id !== 'string'))) refuse('Allowed roles must be an array of role IDs');
    const roles = input.roleIds || [];
    if (await db.role.count({ where: { id: { in: roles } } }) !== new Set(roles).size) refuse('An assigned role does not exist');
    if (input.layoutId && !await db.pageLayout.findFirst({ where: { id: input.layoutId, module: input.module, active: true } })) refuse('Choose an active layout of this module');
    if (input.allowedValues != null && (typeof input.allowedValues !== 'object' || Array.isArray(input.allowedValues))) refuse('Allowed values must be keyed by field');
    for (const [field, values] of Object.entries(input.allowedValues || {})) {
      if (!fieldNames.has(field) || !Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string')) refuse('Allowed values need a known field and a nonempty list of strings');
    }
  } else {
    if (!Array.isArray(input.sections) || input.sections.length > 50) refuse('Layout sections must be an array of at most 50 sections');
    const used = new Set();
    for (const section of input.sections) {
      if (!section || !Array.isArray(section.fields)) refuse('Each layout section needs fields');
      for (const field of section.fields) {
        if (!field || !fieldNames.has(field.name) || used.has(field.name)) refuse('Layout fields must be known and appear once');
        if (field.required != null && typeof field.required !== 'boolean' || field.readOnly != null && typeof field.readOnly !== 'boolean') refuse('Required and read-only flags must be boolean');
        used.add(field.name);
      }
    }
  }
}
module.exports.validateConfiguration = validateConfiguration;
