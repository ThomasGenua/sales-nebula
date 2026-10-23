const { Prisma } = require('@prisma/client');
const { modelModules } = require('./fieldSecurity');
const { plainFieldProblem } = require('../utils/modelFields');
const { permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
function relations(module) {
  const model = Prisma.dmmf.datamodel.models.find(m => modelModules[m.name] === module);
  return (model?.fields || []).filter(f => f.kind === 'object' && modelModules[f.type]).map(f => {
    const target = Prisma.dmmf.datamodel.models.find(m => m.name === f.type);
    const reverse = target.fields.find(t => t.kind === 'object' && t.relationName === f.relationName && t.relationFromFields?.length === 1);
    return { name: f.name, module: modelModules[f.type], model: f.type[0].toLowerCase() + f.type.slice(1), localKey: f.relationFromFields?.[0], foreignKey: reverse?.relationFromFields?.[0] };
  }).filter(r => r.localKey || r.foreignKey);
}
function problem(module, config) {
  const relation = relations(module).find(r => r.name === config?.relation);
  return !relation ? 'Choose a declared CRM relationship' : plainFieldProblem(relation.model, config.field, config.value);
}
async function execute(db, module, record, config, req, after, prisma) {
  const error = problem(module, config);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const relation = relations(module).find(r => r.name === config.relation);
  if (!permits(req, relation.module, 'edit')) throw new Error('Flow actor lacks related-module edit permission');
  const match = relation.localKey ? { id: record[relation.localKey] || '' } : { [relation.foreignKey]: record.id };
  const rows = await db[relation.model].findMany({ where: await reachableWhere(req, relation.module, relation.model, match, 'Edit'), take: 101 });
  if (rows.length > 100) throw new Error('Related action exceeds 100 records; narrow the relationship');
  for (const row of rows) await require('./recordWrites').updateRecord(db, relation.module, row, { [config.field]: config.value }, { userId: req.userId, req, source: 'related flow action', skipWorkflows: true, after, prisma });
}
module.exports = { relations, problem, execute };
