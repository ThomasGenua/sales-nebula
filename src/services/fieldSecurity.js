const { AsyncLocalStorage } = require('node:async_hooks');
const { Prisma } = require('@prisma/client');
const { isAdmin } = require('../middleware/rowSecurity');
const context = new AsyncLocalStorage();
const models = new Map(Prisma.dmmf.datamodel.models.map(m => [m.name, m]));
const modelModules = { Contact: 'contacts', Account: 'accounts', Lead: 'leads', Deal: 'deals', Case: 'cases', Activity: 'activities', Quote: 'quotes', Invoice: 'invoices', Order: 'orders', Contract: 'contracts', Product: 'products', Project: 'projects', Prospect: 'prospects' };
const protectedFields = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'ownerId', 'assignedId', 'createdById', 'recordTypeId']);
const fail = field => { throw Object.assign(new Error(`Field access denied: ${field}`), { status: 403, code: 'FIELD_ACCESS_DENIED' }); };
const middleware = (req, res, next) => context.run({ req }, next);

async function policies(db) {
  const state = context.getStore();
  if (!state?.req?.user || isAdmin(state.req.user)) return [];
  if (!state.policies) state.policies = (state.policyDb || db).fieldPermission.findMany({ where: { roleId: state.req.user.roleId } });
  return state.policies;
}
function rulesFor(model, rules) { return rules.filter(r => r.module === modelModules[model]); }
function checkQuery(model, input, rules) {
  if (!input || typeof input !== 'object') return;
  if (Array.isArray(input)) return input.forEach(v => checkQuery(model, v, rules));
  const fields = models.get(model)?.fields || [];
  for (const [key, value] of Object.entries(input)) {
    if (rulesFor(model, rules).some(r => r.field === key && !r.visible)) fail(key);
    const relation = fields.find(f => f.name === key && f.kind === 'object');
    if (relation) checkQuery(relation.type, value, rules);
    else if (['AND', 'OR', 'NOT', 'is', 'isNot', 'some', 'every', 'none', 'where', 'orderBy', 'having', '_sum', '_avg', '_min', '_max', '_count'].includes(key)) checkQuery(model, value, rules);
    else if (['by', 'distinct'].includes(key)) for (const field of [].concat(value || [])) if (rulesFor(model, rules).some(r => r.field === field && !r.visible)) fail(field);
  }
}
function checkWrite(model, data, rules) {
  for (const row of [].concat(data || [])) {
    for (const rule of rulesFor(model, rules)) if ((!rule.editable || !rule.visible) && Object.hasOwn(row, rule.field)) fail(rule.field);
    for (const field of models.get(model)?.fields || []) {
      if (field.kind !== 'object' || !row[field.name]) continue;
      const nested = row[field.name];
      for (const op of ['create', 'update', 'upsert', 'connectOrCreate', 'createMany', 'updateMany']) {
        for (const value of [].concat(nested[op] || [])) {
          checkWrite(field.type, value.data || value, rules);
          if (value.create) checkWrite(field.type, value.create, rules);
          if (value.update) checkWrite(field.type, value.update, rules);
        }
      }
    }
  }
}
function redact(model, result, rules) {
  if (Array.isArray(result)) return result.map(row => redact(model, row, rules));
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (model === 'CustomFieldDef' && rules.some(r => r.module === out.module && r.field === 'custom.' + out.name && !r.visible)) delete out.defaultValue;
  if (copies.has(model) && rules.some(r => !r.visible)) fail('historical or indexed data');
  for (const rule of rulesFor(model, rules)) if (!rule.visible) delete out[rule.field];
  for (const field of models.get(model)?.fields || []) if (field.kind === 'object' && out[field.name]) out[field.name] = redact(field.type, out[field.name], rules);
  return out;
}
function checkRelations(model, args, rules) {
  for (const selection of [args?.include, args?.select]) {
    for (const [key, value] of Object.entries(selection || {})) {
      const relation = models.get(model)?.fields.find(f => f.name === key && f.kind === 'object');
      if (relation?.type === 'StudioFieldValue' && rules.some(r => r.field.startsWith('custom.') && !r.visible)) fail('nested custom field values');
      if (key === '_count' && value && typeof value === 'object') checkRelations(model, value, rules);
      if (relation && value && typeof value === 'object') {
        checkQuery(relation.type, value, rules);
        checkRelations(relation.type, value, rules);
      }
    }
  }
}

// These tables contain denormalized copies, prose or JSON of CRM fields.
// Until their projection is field-aware, restricted users cannot read them.
const copies = new Set(['AuditLog', 'EventLog', 'DealHistory', 'DealStageHistory', 'Forecast', 'ForecastItem', 'ForecastSnapshot', 'SearchIndex', 'SearchIndexEntry', 'RecycleBin', 'RecycleBinEntry', 'RecycleBinItem', 'Notification', 'WorkflowLog', 'FlowRun', 'QuoteVersion']);
function secureClient(db) {
  return db.$extends({ name: 'fieldSecurity', query: {
    async $allOperations({ model, operation, args, query }) {
      const rules = await policies(db);
      if (!rules.length) return query(args);
      if (model === 'QuoteShare' && rules.some(r => !r.visible)) fail('shared quote snapshot');
      if (model === 'StudioFieldValue') {
        const customRules = rules.filter(r => r.field.startsWith('custom.') && (!r.visible || !r.editable));
        if (customRules.length) {
          const state = context.getStore();
          if (!state.customFields) state.customFields = (state.policyDb || db).customFieldDef.findMany({ where: { OR: customRules.map(r => ({ module: r.module, name: r.field.slice(7) })) } });
          const fields = await state.customFields;
          const locked = fields.filter(f => customRules.some(r => r.module === f.module && r.field === 'custom.' + f.name));
          const hidden = locked.filter(f => customRules.some(r => r.module === f.module && r.field === 'custom.' + f.name && !r.visible));
          if (/^(find|count|aggregate|groupBy)/.test(operation)) {
            // findUnique cannot accept arbitrary AND in older clients; this
            // deployment uses Prisma's extended unique where input.
            args.where = { ...args.where, AND: [args.where?.AND || {}, { fieldId: { notIn: hidden.map(f => f.id) } }] };
          } else {
            const id = args.where?.fieldId_recordId?.fieldId || args.data?.fieldId || args.create?.fieldId;
            if (!id || locked.some(f => f.id === id)) fail('custom field');
          }
        }
      }
      if (!model) {
        // Raw SQL cannot be projected safely. Reject it under a restricted
        // actor instead of letting JSON/report queries bypass field security.
        if (/Raw/.test(operation)) {
          const raw = args?.[0] || args;
          const sql = typeof raw === 'string' ? raw : raw?.sql || raw?.text || raw?.query || '';
          const lockOnly = /^SELECT id FROM "(?:CustomObject|FlowRun|Forecast|Order)" WHERE id = (?:\?|\$\d+) FOR UPDATE\s*$/i.test(sql.trim());
          if (!lockOnly) fail('raw database access');
        }
        return query(args);
      }
      const reading = /^(find|count|aggregate|groupBy)/.test(operation);
      for (const field of [args?.by, args?.distinct].flat().filter(Boolean)) {
        if (rulesFor(model, rules).some(r => r.field === field && !r.visible)) fail(field);
      }
      checkRelations(model, args, rules);
      if (reading && copies.has(model) && rules.some(r => !r.visible)) fail('historical or indexed data');
      checkQuery(model, { where: args?.where, orderBy: args?.orderBy, having: args?.having, by: args?.by, distinct: args?.distinct,
        _sum: args?._sum, _avg: args?._avg, _min: args?._min, _max: args?._max, _count: args?._count }, rules);
      for (const key of ['data', 'create', 'update']) if (args?.[key]) checkWrite(model, args[key], rules);
      const result = await query(args);
      if (!reading && copies.has(model)) return result && { id: result.id };
      return redact(model, result, rules);
    },
  } });
}

function validField(module, field) {
  const model = Object.keys(modelModules).find(m => modelModules[m] === module);
  return !!model && !protectedFields.has(field) && models.get(model).fields.some(f => f.name === field && f.kind !== 'object');
}
async function assertInput(db, module, input, user) {
  if (!user || isAdmin(user)) return;
  const rules = await db.fieldPermission.findMany({ where: { roleId: user.roleId, module } });
  const model = Object.keys(modelModules).find(m => modelModules[m] === module);
  checkWrite(model, input, rules);
}
module.exports = { context, middleware, policies, secureClient, checkQuery, checkWrite, redact, validField, modelModules, assertInput };
