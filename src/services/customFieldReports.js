const custom = require('./customFields');
const matches = (value, filter) => {
  const v = filter.value, text = x => String(x ?? '').toLowerCase(), list = x => Array.isArray(x) ? x : String(x).split(',').map(s => s.trim());
  const compare = x => Number.isFinite(Number(x)) && x !== '' && x !== null ? Number(x) : x;
  switch (filter.operator) {
    case 'equals': return text(value) === text(v);
    case 'not_equals': return text(value) !== text(v);
    case 'contains': return text(value).includes(text(v));
    case 'not_contains': return !text(value).includes(text(v));
    case 'starts_with': return text(value).startsWith(text(v));
    case 'ends_with': return text(value).endsWith(text(v));
    case 'in': return list(v).some(x => text(x) === text(value));
    case 'not_in': return !list(v).some(x => text(x) === text(value));
    case 'is_null': return value == null;
    case 'is_not_null': return value != null;
    case 'gt': case 'date_after': return value != null && compare(value) > compare(v);
    case 'gte': return value != null && compare(value) >= compare(v);
    case 'lt': case 'date_before': return value != null && compare(value) < compare(v);
    case 'lte': return value != null && compare(value) <= compare(v);
    case 'between': case 'date_between': { const [a, b] = list(v); return value != null && compare(value) >= compare(a) && compare(value) <= compare(b); }
    case 'last_n_days': return Date.parse(value) >= Date.now() - Number(v) * 86400000;
    case 'this_year': case 'this_month': case 'this_quarter': {
      const date = new Date(value), now = new Date();
      return date.getFullYear() === now.getFullYear() && (filter.operator === 'this_year' || (filter.operator === 'this_month' ? date.getMonth() === now.getMonth() : Math.floor(date.getMonth() / 3) === Math.floor(now.getMonth() / 3)));
    }
    default: throw Object.assign(new Error('Unsupported custom field filter: ' + filter.operator), { status: 400 });
  }
};
function aggregate(rows, aggregations) {
  const result = {};
  for (const a of aggregations) {
    const fn = a.function || 'count', values = rows.map(r => r[a.field]).filter(v => v != null);
    if (fn !== 'count' && values.some(v => typeof v !== 'number')) throw Object.assign(new Error('Numeric measures need a number field'), { status: 400 });
    const n = fn === 'count' ? values.length : !values.length ? null : fn === 'sum' ? values.reduce((a, b) => a + b, 0) : fn === 'avg' ? values.reduce((a, b) => a + b, 0) / values.length : fn === 'min' ? Math.min(...values) : Math.max(...values);
    (result['_' + fn] ||= {})[a.field] = n;
  }
  return result;
}
async function execute(db, config, report, where) {
  let rows = await db[config.model].findMany({ where, take: 10001 });
  if (rows.length > 10000) throw Object.assign(new Error('Narrow this report with record filters to at most 10,000 rows before using custom fields.'), { status: 400 });
  await custom.hydrate(db, report.module, rows);
  rows = rows.filter(row => report.filters.filter(f => f.field.startsWith('custom.')).every(f => matches(row[f.field], f)));
  for (const sort of [...report.sortBy].reverse()) rows.sort((a, b) => (typeof a[sort.field] === 'number' && typeof b[sort.field] === 'number' ? a[sort.field] - b[sort.field] : String(a[sort.field] ?? '').localeCompare(String(b[sort.field] ?? ''))) * (sort.direction === 'desc' ? -1 : 1));
  const result = { module: report.module, reportType: report.reportType, executedAt: new Date().toISOString(), totalCount: rows.length, returnedCount: Math.min(rows.length, report.limit) };
  const columns = report.columns.length ? [...new Set(['id', ...report.columns.map(c => c.field)])] : Object.keys(config.fields);
  result.rows = rows.slice(0, report.limit).map(r => Object.fromEntries(columns.map(k => [k, r[k] ?? null])));
  const groups = new Map();
  for (const row of rows) { const key = JSON.stringify(report.groupBy.map(k => row[k])); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  const grouped = [...groups.values()].map(group => ({ ...Object.fromEntries(report.groupBy.map(k => [k, group[0][k]])), ...aggregate(group, report.aggregations) }));
  if (['summary', 'matrix'].includes(report.reportType)) result.summary = report.groupBy.length ? { type: 'grouped', data: grouped } : { type: 'totals', data: aggregate(rows, report.aggregations) };
  if (report.reportType === 'chart') { result.chartType = report.chartType || 'bar'; result.chartData = [...groups.values()].map(group => ({ label: report.groupBy.map(k => group[0][k] ?? 'Not set').join(' | '), count: group.length, ...Object.fromEntries(Object.entries(aggregate(group, report.aggregations)).flatMap(([fn, values]) => Object.entries(values).map(([field, value]) => [fn.slice(1) + '_' + field, value]))) })); }
  result.totals = { type: 'totals', data: aggregate(rows, report.aggregations) };
  return result;
}
module.exports = { execute, matches, aggregate };
