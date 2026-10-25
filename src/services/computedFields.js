const {
  evaluateFormula
} = require('../utils/formula');
const {
  context,
  policies
} = require('./fieldSecurity');
const {
  permits
} = require('../middleware/auth');
const {
  reachableWhere
} = require('../middleware/access');
const relations = {
  accounts: {
    deals: ['deal', 'accountId'],
    invoices: ['invoice', 'accountId'],
    cases: ['case', 'accountId']
  },
  contacts: {
    deals: ['deal', 'contactId']
  },
  deals: {
    activities: ['activity', 'dealId']
  }
};
const fail = message => {
  throw Object.assign(new Error(message), {
    status: 400
  });
};
async function definitions(db, module) {
  const rules = await policies(db),
    req = context.getStore()?.req;
  const fields = await db.formulaField.findMany({
    where: {
      module,
      active: true
    },
    orderBy: {
      fieldKey: 'asc'
    }
  });
  return fields.filter(f => !rules.some(r => !r.visible && (r.module === module || r.module === f.rollup?.module)) && (!f.rollup || !req || permits(req, f.rollup.module, 'read'))).map(f => ({
    ...f,
    computed: true,
    label: f.name,
    name: f.fieldKey,
    fieldType: f.returnType === 'number' || f.returnType === 'currency' || f.returnType === 'percent' ? 'number' : f.returnType === 'boolean' ? 'boolean' : 'text',
    supported: true,
    reportable: true,
    readOnly: true,
    required: false,
    options: []
  }));
}
function validate(field) {
  if (field.precision != null && (!Number.isInteger(field.precision) || field.precision < 0 || field.precision > 10)) fail('Precision must be an integer from 0 to 10');
  if (!Object.values(require('./fieldSecurity').modelModules).includes(field.module)) fail('Choose a supported CRM module');
  if (typeof field.name !== 'string' || !field.name.trim()) fail('A field name is required');
  if (field.rollup) {
    const r = field.rollup;
    if (!relations[field.module]?.[r.module] || !['count', 'sum', 'avg', 'min', 'max'].includes(r.function)) fail('Choose a supported child relationship and aggregation');
    const model = require('@prisma/client').Prisma.dmmf.datamodel.models.find(m => m.name.toLowerCase() === relations[field.module][r.module][0].toLowerCase());
    if (r.function !== 'count' && !model.fields.some(f => f.name === r.field && ['Int', 'Float'].includes(f.type))) fail('Rollup requires a numeric child field');
    if (r.filters != null && (!Array.isArray(r.filters) || r.filters.length > 10 || r.filters.some(f => !model.fields.some(k => k.name === f.field && k.kind !== 'object') || !['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'].includes(f.operator)))) fail('Invalid rollup filters');
  } else {
    const value = evaluateFormula(field.formula, {});
    if (value?.error) fail(value.error);
  }
}
async function hydrate(db, module, rows, fields) {
  fields = fields || (await definitions(db, module));
  const req = context.getStore()?.req;
  for (const f of fields) {
    let related = [];
    if (f.rollup) {
      const r = f.rollup,
        [model, fk] = relations[module]?.[r.module] || [];
      if (!model) continue;
      const where = {
        deletedAt: null,
        [fk]: {
          in: rows.map(row => row.id)
        }
      };
      related = await db[model].findMany({
        where: req ? await reachableWhere(req, r.module, model, where) : where,
        take: 10001
      });
      if (related.length > 10000) fail('Rollup exceeds 10,000 related records');
      related = related.filter(row => (r.filters || []).every(filter => require('./customFieldReports').matches(row[filter.field], filter)));
      for (const row of rows) {
        const children = related.filter(c => c[fk] === row.id);
        if (r.function !== 'count' && ['deals', 'invoices'].includes(r.module) && new Set(children.map(c => c.currency || '')).size > 1) fail('Monetary rollups require one currency');
        row['custom.' + f.name] = r.function === 'count' ? children.length : require('./customFieldReports').aggregate(children, [{
          field: r.field,
          function: r.function
        }])['_' + r.function][r.field];
      }
    } else for (const row of rows) {
      let value = evaluateFormula(f.formula, row);
      if (value?.error || typeof value === 'number' && !Number.isFinite(value)) value = null;
      if (typeof value === 'number' && f.precision != null) value = Number(value.toFixed(Math.min(10, Math.max(0, f.precision))));
      row['custom.' + f.name] = value;
    }
  }
  return rows;
}
async function filterIds(db, module, filters, fields) {
  const model = Object.entries(require('./fieldSecurity').modelModules).find(([, m]) => m === module)?.[0];
  if (!model) return [];
  const req = context.getStore()?.req,
    delegate = model[0].toLowerCase() + model.slice(1);
  const rows = await db[delegate].findMany({
    where: req ? await reachableWhere(req, module, delegate) : {
      deletedAt: null
    },
    take: 10001
  });
  if (rows.length > 10000) fail('Computed field filtering exceeds 10,000 records');
  await hydrate(db, module, rows, fields);
  return rows.filter(r => filters.every(f => require('./customFieldReports').matches(r[f.field], {
    ...f,
    operator: f.operator || 'equals'
  }))).map(r => r.id);
}
async function forActor(db, req, module, rows) {
  const {
    secureClient
  } = require('./fieldSecurity');
  const scoped = typeof db.$extends === 'function' ? secureClient(db) : db;
  return context.run({
    req,
    policyDb: db
  }, () => hydrate(scoped, module, rows));
}
module.exports = {
  relations,
  definitions,
  validate,
  hydrate,
  filterIds,
  forActor
};
