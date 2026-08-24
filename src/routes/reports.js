/**
 * Report Builder API
 * Save report definitions (module, filters, groupings, aggregations, chart type)
 * and execute them dynamically against the database.
 * 
 * Supports: tabular, summary, matrix, and chart report types.
 * Features: saved reports, folders, scheduling, export (CSV/JSON), sharing.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { cache, cacheMiddleware } = require('../services/cache');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── MODULE METADATA ───
// Maps module names to Prisma models and their available fields
const MODULE_CONFIG = {
  contacts: {
    model: 'contact',
    fields: {
      id: { type: 'string', label: 'ID' },
      firstName: { type: 'string', label: 'First Name' },
      lastName: { type: 'string', label: 'Last Name' },
      email: { type: 'string', label: 'Email' },
      phone: { type: 'string', label: 'Phone' },
      title: { type: 'string', label: 'Title' },
      department: { type: 'string', label: 'Department' },
      source: { type: 'string', label: 'Source' },
      status: { type: 'string', label: 'Status' },
      createdAt: { type: 'date', label: 'Created At' },
      updatedAt: { type: 'date', label: 'Updated At' },
    },
    relations: { account: 'accountId' },
  },
  leads: {
    model: 'lead',
    fields: {
      id: { type: 'string', label: 'ID' },
      firstName: { type: 'string', label: 'First Name' },
      lastName: { type: 'string', label: 'Last Name' },
      email: { type: 'string', label: 'Email' },
      company: { type: 'string', label: 'Company' },
      title: { type: 'string', label: 'Title' },
      source: { type: 'string', label: 'Source' },
      status: { type: 'string', label: 'Status' },
      rating: { type: 'string', label: 'Rating' },
      score: { type: 'number', label: 'Score' },
      createdAt: { type: 'date', label: 'Created At' },
      updatedAt: { type: 'date', label: 'Updated At' },
    },
    relations: {},
  },
  deals: {
    model: 'deal',
    fields: {
      id: { type: 'string', label: 'ID' },
      name: { type: 'string', label: 'Deal Name' },
      value: { type: 'number', label: 'Value' },
      stage: { type: 'string', label: 'Stage' },
      probability: { type: 'number', label: 'Probability' },
      closeDate: { type: 'date', label: 'Close Date' },
      source: { type: 'string', label: 'Source' },
      type: { type: 'string', label: 'Type' },
      createdAt: { type: 'date', label: 'Created At' },
      updatedAt: { type: 'date', label: 'Updated At' },
    },
    relations: { account: 'accountId', owner: 'ownerId', contact: 'contactId' },
  },
  accounts: {
    model: 'account',
    fields: {
      id: { type: 'string', label: 'ID' },
      name: { type: 'string', label: 'Account Name' },
      industry: { type: 'string', label: 'Industry' },
      type: { type: 'string', label: 'Type' },
      website: { type: 'string', label: 'Website' },
      phone: { type: 'string', label: 'Phone' },
      revenue: { type: 'number', label: 'Revenue' },
      employees: { type: 'number', label: 'Employees' },
      createdAt: { type: 'date', label: 'Created At' },
      updatedAt: { type: 'date', label: 'Updated At' },
    },
    relations: {},
  },
  activities: {
    model: 'activity',
    fields: {
      id: { type: 'string', label: 'ID' },
      type: { type: 'string', label: 'Type' },
      subject: { type: 'string', label: 'Subject' },
      status: { type: 'string', label: 'Status' },
      priority: { type: 'string', label: 'Priority' },
      date: { type: 'date', label: 'Date' },
      createdAt: { type: 'date', label: 'Created At' },
    },
    relations: { contact: 'contactId', deal: 'dealId', assignedTo: 'assignedId' },
  },
  cases: {
    model: 'case',
    fields: {
      id: { type: 'string', label: 'ID' },
      caseNumber: { type: 'string', label: 'Case Number' },
      subject: { type: 'string', label: 'Subject' },
      status: { type: 'string', label: 'Status' },
      priority: { type: 'string', label: 'Priority' },
      type: { type: 'string', label: 'Type' },
      origin: { type: 'string', label: 'Origin' },
      createdAt: { type: 'date', label: 'Created At' },
      closedAt: { type: 'date', label: 'Closed At' },
    },
    relations: { contact: 'contactId', account: 'accountId', assignedTo: 'assignedId' },
  },
  products: {
    model: 'product',
    fields: {
      id: { type: 'string', label: 'ID' },
      name: { type: 'string', label: 'Name' },
      sku: { type: 'string', label: 'SKU' },
      category: { type: 'string', label: 'Category' },
      price: { type: 'number', label: 'Price' },
      cost: { type: 'number', label: 'Cost' },
      active: { type: 'boolean', label: 'Active' },
      createdAt: { type: 'date', label: 'Created At' },
    },
    relations: {},
  },
  invoices: {
    model: 'invoice',
    fields: {
      id: { type: 'string', label: 'ID' },
      number: { type: 'string', label: 'Invoice Number' },
      status: { type: 'string', label: 'Status' },
      total: { type: 'number', label: 'Total' },
      tax: { type: 'number', label: 'Tax' },
      dueDate: { type: 'date', label: 'Due Date' },
      paidDate: { type: 'date', label: 'Paid Date' },
      createdAt: { type: 'date', label: 'Created At' },
    },
    relations: { contact: 'contactId', account: 'accountId', quote: 'quoteId' },
  },
  quotes: {
    model: 'quote',
    fields: {
      id: { type: 'string', label: 'ID' },
      number: { type: 'string', label: 'Quote Number' },
      status: { type: 'string', label: 'Status' },
      total: { type: 'number', label: 'Total' },
      discount: { type: 'number', label: 'Discount' },
      tax: { type: 'number', label: 'Tax' },
      validUntil: { type: 'date', label: 'Valid Until' },
      createdAt: { type: 'date', label: 'Created At' },
    },
    relations: { deal: 'dealId', contact: 'contactId', account: 'accountId' },
  },
};

// ─── FILTER OPERATORS ───
const OPERATORS = {
  equals: (f, v) => ({ [f]: v }),
  not_equals: (f, v) => ({ NOT: { [f]: v } }),
  contains: (f, v) => ({ [f]: { contains: v, mode: 'insensitive' } }),
  not_contains: (f, v) => ({ NOT: { [f]: { contains: v, mode: 'insensitive' } } }),
  starts_with: (f, v) => ({ [f]: { startsWith: v, mode: 'insensitive' } }),
  ends_with: (f, v) => ({ [f]: { endsWith: v, mode: 'insensitive' } }),
  gt: (f, v) => ({ [f]: { gt: parseNum(v) } }),
  gte: (f, v) => ({ [f]: { gte: parseNum(v) } }),
  lt: (f, v) => ({ [f]: { lt: parseNum(v) } }),
  lte: (f, v) => ({ [f]: { lte: parseNum(v) } }),
  in: (f, v) => ({ [f]: { in: Array.isArray(v) ? v : v.split(',').map(s => s.trim()) } }),
  not_in: (f, v) => ({ NOT: { [f]: { in: Array.isArray(v) ? v : v.split(',').map(s => s.trim()) } } }),
  is_null: (f) => ({ [f]: null }),
  is_not_null: (f) => ({ NOT: { [f]: null } }),
  between: (f, v) => {
    const [min, max] = Array.isArray(v) ? v : v.split(',');
    return { [f]: { gte: parseNum(min), lte: parseNum(max) } };
  },
  date_after: (f, v) => ({ [f]: { gt: new Date(v) } }),
  date_before: (f, v) => ({ [f]: { lt: new Date(v) } }),
  date_between: (f, v) => {
    const [start, end] = Array.isArray(v) ? v : v.split(',');
    return { [f]: { gte: new Date(start.trim()), lte: new Date(end.trim()) } };
  },
  this_month: (f) => {
    const now = new Date();
    return { [f]: { gte: new Date(now.getFullYear(), now.getMonth(), 1), lt: new Date(now.getFullYear(), now.getMonth() + 1, 1) } };
  },
  this_quarter: (f) => {
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3);
    return { [f]: { gte: new Date(now.getFullYear(), q * 3, 1), lt: new Date(now.getFullYear(), (q + 1) * 3, 1) } };
  },
  this_year: (f) => {
    const y = new Date().getFullYear();
    return { [f]: { gte: new Date(y, 0, 1), lt: new Date(y + 1, 0, 1) } };
  },
  last_n_days: (f, v) => {
    const d = new Date(); d.setDate(d.getDate() - parseInt(v));
    return { [f]: { gte: d } };
  },
};

function parseNum(v) {
  const n = Number(v);
  return isNaN(n) ? v : n;
}

// Build Prisma where clause from report filters
function buildWhere(filters = []) {
  if (!filters.length) return {};
  const conditions = filters.map(f => {
    const op = OPERATORS[f.operator];
    if (!op) return {};
    return op(f.field, f.value);
  }).filter(c => Object.keys(c).length > 0);
  return conditions.length ? { AND: conditions } : {};
}

// Build Prisma orderBy from sort config
function buildOrderBy(sortBy = []) {
  if (!sortBy.length) return [{ createdAt: 'desc' }];
  return sortBy.map(s => ({ [s.field]: s.direction || 'asc' }));
}

// Build select from columns
function buildSelect(columns = []) {
  if (!columns.length) return undefined;
  const select = {};
  columns.forEach(c => { select[c.field] = true; });
  select.id = true; // Always include ID
  return select;
}

// Execute aggregations via Prisma aggregate/groupBy
async function executeAggregations(prisma, modelName, where, aggregations, groupBy) {
  const model = prisma[modelName];
  if (!model) return null;

  // If we have groupBy fields, use Prisma groupBy
  if (groupBy && groupBy.length > 0) {
    const aggConfig = {};
    for (const agg of aggregations) {
      const fn = agg.function || 'count';
      if (!aggConfig[`_${fn}`]) aggConfig[`_${fn}`] = {};
      if (fn === 'count') {
        aggConfig._count = aggConfig._count || {};
        aggConfig._count[agg.field] = true;
      } else {
        aggConfig[`_${fn}`][agg.field] = true;
      }
    }

    try {
      const result = await model.groupBy({
        by: groupBy,
        where,
        ...aggConfig,
        orderBy: groupBy.map(g => ({ [g]: 'asc' })),
      });
      return { type: 'grouped', data: result };
    } catch (e) {
      // Some fields might not support aggregation, fall back to manual
      return { type: 'grouped', data: [], error: e.message };
    }
  }

  // No groupBy, just aggregate totals
  const aggConfig = {};
  for (const agg of aggregations) {
    const fn = agg.function || 'count';
    if (fn === 'count') {
      aggConfig._count = aggConfig._count || true;
    } else {
      if (!aggConfig[`_${fn}`]) aggConfig[`_${fn}`] = {};
      aggConfig[`_${fn}`][agg.field] = true;
    }
  }

  try {
    const result = await model.aggregate({ where, ...aggConfig });
    return { type: 'totals', data: result };
  } catch (e) {
    return { type: 'totals', data: null, error: e.message };
  }
}

// ─── GET /api/reports/metadata ───
// Returns available modules, fields, operators for the report builder UI
router.get('/metadata', (req, res) => {
  const modules = {};
  for (const [key, config] of Object.entries(MODULE_CONFIG)) {
    modules[key] = {
      label: key.charAt(0).toUpperCase() + key.slice(1),
      fields: config.fields,
      relations: Object.keys(config.relations),
    };
  }
  res.json({
    modules,
    operators: Object.keys(OPERATORS),
    aggregationFunctions: ['count', 'sum', 'avg', 'min', 'max'],
    reportTypes: ['tabular', 'summary', 'matrix', 'chart'],
    chartTypes: ['bar', 'line', 'pie', 'donut', 'funnel', 'scatter', 'area'],
  });
});

// ─── GET /api/reports ───
// List saved reports
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, type, folder, search } = req.query;
    const where = {};
    if (module) where.module = module;
    if (type) where.reportType = type;
    if (folder) where.folderId = folder;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    // Show own reports + public reports
    where.OR = [{ createdById: req.userId }, { isPublic: true }];

    const reports = await prisma.report.findMany({
      where,
      include: { createdBy: { select: { id: true, firstName: true, lastName: true } }, folder: true, _count: { select: { schedules: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(reports);
  } catch (err) { next(err); }
});

// ─── GET /api/reports/:id ───
router.get('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: { createdBy: { select: { id: true, firstName: true, lastName: true } }, folder: true, schedules: true },
    });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (!report.isPublic && report.createdById !== req.userId) return res.status(403).json({ error: 'Access denied' });
    res.json(report);
  } catch (err) { next(err); }
});

// ─── POST /api/reports ───
// Create a saved report definition
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, module, reportType, chartType, columns, filters, groupBy, aggregations, sortBy, joins, limit, isPublic, folderId } = req.body;

    if (!name || !module) return res.status(400).json({ error: 'name and module required' });
    if (!MODULE_CONFIG[module]) return res.status(400).json({ error: `Invalid module: ${module}` });

    const report = await prisma.report.create({
      data: {
        name, description, module,
        reportType: reportType || 'tabular',
        chartType: chartType || null,
        columns: columns || [],
        filters: filters || [],
        groupBy: groupBy || [],
        aggregations: aggregations || [],
        sortBy: sortBy || [],
        joins: joins || [],
        limit: limit || null,
        isPublic: isPublic || false,
        folderId: folderId || null,
        createdById: req.userId,
      },
      include: { createdBy: { select: { id: true, firstName: true, lastName: true } } },
    });
    res.status(201).json(report);
  } catch (err) { next(err); }
});

// ─── PUT /api/reports/:id ───
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Report not found' });
    if (existing.createdById !== req.userId) return res.status(403).json({ error: 'Only owner can edit' });

    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: req.body,
      include: { createdBy: { select: { id: true, firstName: true, lastName: true } } },
    });
    res.json(report);
  } catch (err) { next(err); }
});

// ─── DELETE /api/reports/:id ───
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Report not found' });
    if (existing.createdById !== req.userId) return res.status(403).json({ error: 'Only owner can delete' });
    await prisma.report.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── POST /api/reports/:id/execute ───
// Execute a saved report and return results
router.post('/:id/execute', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (!report.isPublic && report.createdById !== req.userId) return res.status(403).json({ error: 'Access denied' });

    const result = await executeReport(prisma, report);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── POST /api/reports/execute ───
// Execute an ad-hoc report (no save required)
router.post('/execute', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, columns, filters, groupBy, aggregations, sortBy, limit, reportType } = req.body;
    if (!module) return res.status(400).json({ error: 'module required' });
    if (!MODULE_CONFIG[module]) return res.status(400).json({ error: `Invalid module: ${module}` });

    const reportDef = { module, columns: columns || [], filters: filters || [], groupBy: groupBy || [], aggregations: aggregations || [], sortBy: sortBy || [], limit, reportType: reportType || 'tabular' };
    const result = await executeReport(prisma, reportDef);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Core report execution engine ───
async function executeReport(prisma, report) {
  const config = MODULE_CONFIG[report.module];
  if (!config) throw new Error(`Unknown module: ${report.module}`);

  const model = prisma[config.model];
  if (!model) throw new Error(`Prisma model not found: ${config.model}`);

  const where = buildWhere(report.filters);
  const orderBy = buildOrderBy(report.sortBy);
  const startTime = Date.now();

  const result = { reportType: report.reportType || 'tabular', module: report.module, executedAt: new Date().toISOString() };

  // Tabular: raw rows
  if (report.reportType === 'tabular' || !report.reportType) {
    const select = buildSelect(report.columns);
    const findArgs = { where, orderBy };
    if (select) findArgs.select = select;
    if (report.limit) findArgs.take = report.limit;

    // Include related data names
    const include = {};
    for (const [rel, fk] of Object.entries(config.relations)) {
      if (rel === 'owner' || rel === 'assignee') {
        include[rel] = { select: { id: true, firstName: true, lastName: true } };
      } else {
        include[rel] = { select: { id: true, name: true } };
      }
    }
    if (Object.keys(include).length && !select) findArgs.include = include;

    const rows = await model.findMany(findArgs);
    const count = await model.count({ where });

    result.rows = rows;
    result.totalCount = count;
    result.returnedCount = rows.length;
  }

  // Summary: grouped aggregations
  if (report.reportType === 'summary' || report.reportType === 'matrix') {
    const groupBy = report.groupBy || [];
    const aggregations = report.aggregations || [];

    if (groupBy.length > 0 && aggregations.length > 0) {
      result.summary = await executeAggregations(prisma, config.model, where, aggregations, groupBy);
    } else if (aggregations.length > 0) {
      result.summary = await executeAggregations(prisma, config.model, where, aggregations, []);
    }

    // Also return raw data for drill-down
    const rows = await model.findMany({ where, orderBy, take: report.limit || 1000 });
    result.rows = rows;
    result.totalCount = rows.length;
  }

  // Chart: same as summary but structured for chart rendering
  if (report.reportType === 'chart') {
    const groupBy = report.groupBy || [];
    const aggregations = report.aggregations || [];

    if (groupBy.length > 0) {
      // Manual grouping for chart data
      const rows = await model.findMany({ where, take: 10000 });
      const groups = {};

      for (const row of rows) {
        const key = groupBy.map(g => row[g] || 'N/A').join(' | ');
        if (!groups[key]) groups[key] = { label: key, count: 0, _rows: [] };
        groups[key].count++;
        groups[key]._rows.push(row);

        // Calculate aggregations per group
        for (const agg of aggregations) {
          const aggKey = `${agg.function}_${agg.field}`;
          if (!groups[key][aggKey]) groups[key][aggKey] = 0;
          const val = parseFloat(row[agg.field]) || 0;
          if (agg.function === 'sum') groups[key][aggKey] += val;
          if (agg.function === 'max') groups[key][aggKey] = Math.max(groups[key][aggKey], val);
          if (agg.function === 'min') groups[key][aggKey] = groups[key][aggKey] === 0 ? val : Math.min(groups[key][aggKey], val);
        }
      }

      // Finalize averages
      for (const group of Object.values(groups)) {
        for (const agg of aggregations) {
          if (agg.function === 'avg') {
            const sumKey = `sum_${agg.field}`;
            const avgKey = `avg_${agg.field}`;
            const sum = group._rows.reduce((s, r) => s + (parseFloat(r[agg.field]) || 0), 0);
            group[avgKey] = group.count > 0 ? sum / group.count : 0;
          }
        }
        delete group._rows;
      }

      result.chartData = Object.values(groups).sort((a, b) => b.count - a.count);
    }

    result.chartType = report.chartType || 'bar';
  }

  // Always include grand totals if aggregations defined
  if (report.aggregations?.length > 0 && report.reportType !== 'summary') {
    result.totals = await executeAggregations(prisma, config.model, where, report.aggregations, []);
  }

  result.executionMs = Date.now() - startTime;
  return result;
}

// ─── POST /api/reports/:id/export ───
// Export report results as CSV or JSON
router.post('/:id/export', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const format = req.body.format || 'csv';
    const result = await executeReport(prisma, report);
    const rows = result.rows || [];

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${report.name}.json"`);
      res.json(rows);
    } else {
      // CSV
      if (rows.length === 0) return res.status(200).send('');
      const headers = Object.keys(rows[0]).filter(k => k !== 'id');
      const csv = [
        headers.join(','),
        ...rows.map(row => headers.map(h => {
          const val = row[h];
          if (val == null) return '';
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(',')),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${report.name}.csv"`);
      res.send(csv);
    }
  } catch (err) { next(err); }
});

// ─── POST /api/reports/preview ───
// Quick preview: execute ad-hoc with limit 25
router.post('/preview', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const reportDef = { ...req.body, limit: 25, reportType: req.body.reportType || 'tabular' };
    if (!reportDef.module) return res.status(400).json({ error: 'module required' });
    const result = await executeReport(prisma, reportDef);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Report Folders ───

router.get('/folders/all', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const folders = await prisma.reportFolder.findMany({
      include: { _count: { select: { reports: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(folders);
  } catch (err) { next(err); }
});

router.post('/folders', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const folder = await prisma.reportFolder.create({ data: { name: req.body.name, parentId: req.body.parentId } });
    res.status(201).json(folder);
  } catch (err) { next(err); }
});

router.delete('/folders/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.report.updateMany({ where: { folderId: req.params.id }, data: { folderId: null } });
    await prisma.reportFolder.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── Report Schedules ───

router.post('/:id/schedule', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { cron, format, recipients } = req.body;
    if (!cron) return res.status(400).json({ error: 'cron expression required' });
    const schedule = await prisma.reportSchedule.create({
      data: { reportId: req.params.id, cron, format: format || 'csv', recipients: recipients || [] },
    });
    res.status(201).json(schedule);
  } catch (err) { next(err); }
});

router.delete('/schedule/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.reportSchedule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── Clone a report ───
router.post('/:id/clone', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const source = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!source) return res.status(404).json({ error: 'Report not found' });

    const { id, createdAt, updatedAt, createdById, ...data } = source;
    const clone = await prisma.report.create({
      data: { ...data, name: `${source.name} (Copy)`, createdById: req.userId, isPublic: false },
    });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

module.exports = router;
