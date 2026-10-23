const { matches, aggregate } = require('./customFieldReports');
const { permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { canAccess } = require('./customObjectAccess');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

function summarize(rows, report) {
  rows = rows.filter(r => (report.filters || []).every(f => matches(r[f.field], f)));
  for (const sort of [...(report.sortBy || [])].reverse()) rows.sort((a, b) => (typeof a[sort.field] === 'number' ? a[sort.field] - b[sort.field] : String(a[sort.field] ?? '').localeCompare(String(b[sort.field] ?? ''))) * (sort.direction === 'desc' ? -1 : 1));
  const groups = new Map(), groupBy = report.groupBy || [];
  for (const row of rows) { const key = JSON.stringify(groupBy.map(f => row[f] ?? null)); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  const measures = report.aggregations || [];
  if (report.module === 'deals' && measures.some(a => a.field === 'value' && a.function !== 'count') && new Set(rows.map(r => r.currency)).size > 1) {
    fail('Filter this report to one currency before aggregating deal values');
  }
  const grouped = [...groups.values()].map(g => ({ ...Object.fromEntries(groupBy.map(k => [k, g[0][k] ?? null])), ...aggregate(g, measures) }));
  const columns = report.columns?.length ? ['id', ...report.columns.map(c => c.field)] : null;
  const result = { module: report.module, reportType: report.reportType, totalCount: rows.length, rows: rows.slice(0, report.limit || 1000).map(r => columns ? Object.fromEntries(columns.map(k => [k, r[k] ?? null])) : r),
    summary: groupBy.length ? { type: 'grouped', data: grouped } : { type: 'totals', data: aggregate(rows, measures) }, totals: { type: 'totals', data: aggregate(rows, measures) } };
  if (report.reportType === 'matrix') {
    if (groupBy.length !== 2) fail('Matrix reports need exactly two grouping fields');
    const [rowField, columnField] = groupBy;
    const rowValues = [...new Set(rows.map(r => r[rowField] ?? null))], columnValues = [...new Set(rows.map(r => r[columnField] ?? null))];
    if (rowValues.length * columnValues.length > 10000) fail('Narrow the matrix to at most 10,000 cells');
    result.matrix = { rowField, columnField, rowValues, columnValues, cells: grouped, rowTotals: rowValues.map(value => ({ value, ...aggregate(rows.filter(r => (r[rowField] ?? null) === value), measures) })), columnTotals: columnValues.map(value => ({ value, ...aggregate(rows.filter(r => (r[columnField] ?? null) === value), measures) })) };
  }
  return result;
}

async function customConfig(db, req, module) {
  const id = module.slice(7);
  if (!canAccess(req, id)) throw Object.assign(new Error('Insufficient custom-object permissions'), { status: 403 });
  const object = await db.customObject.findFirst({ where: { id, deletedAt: null }, include: { fields: true } });
  if (!object) fail('Custom object not found');
  return { label: object.label, model: 'customRecord', relations: {}, fields: { id: { label: 'ID', type: 'string' }, ...Object.fromEntries(object.fields.map(f => [f.apiName, { label: f.label, type: ['Number', 'Currency'].includes(f.type) ? 'number' : 'string' }])) } };
}

async function execute(db, report, req, configs, config) {
  let rows;
  if (report.module.startsWith('custom:')) {
    rows = (await db.customRecord.findMany({ where: { customObjectId: report.module.slice(7), deletedAt: null }, take: 10001 })).map(r => ({ ...r.data, id: r.id }));
  } else {
    rows = await db[config.model].findMany({ where: await reachableWhere(req, report.module, config.model), take: 10001 });
    for (const [relation, fk] of Object.entries(config.relations)) {
      const relatedModule = ({ account: 'accounts', contact: 'contacts', deal: 'deals' })[relation];
      if (!relatedModule || !configs[relatedModule] || !permits(req, relatedModule, 'read')) continue;
      const target = configs[relatedModule];
      const ids = [...new Set(rows.map(r => r[fk]).filter(Boolean))];
      const related = await db[target.model].findMany({ where: await reachableWhere(req, relatedModule, target.model, { id: { in: ids } }) });
      const byId = new Map(related.map(r => [r.id, r]));
      rows = rows.map(r => ({ ...r, ...Object.fromEntries(Object.keys(target.fields).map(f => [relation + '.' + f, byId.get(r[fk])?.[f] ?? null])) }));
    }
  }
  if (rows.length > 10000) fail('This report exceeds the 10,000-record processing limit');
  // Restrict projections to registered report fields, never arbitrary JSON.
  rows = rows.map(r => Object.fromEntries(Object.keys(config.fields).map(k => [k, r[k] ?? null])));
  return summarize(rows, report);
}
module.exports = { execute, customConfig, summarize };
