const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── ADMIN CONFIG ───

router.get('/config', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configs = await prisma.adminConfig.findMany();
    const obj = {};
    configs.forEach(c => { obj[c.key] = c.value; });
    res.json(obj);
  } catch (err) { next(err); }
});

router.put('/config', requirePermission('settings', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await prisma.adminConfig.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── CUSTOM FIELDS ───

router.get('/custom-fields', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const fields = await prisma.customField.findMany({ orderBy: { module: 'asc' } });
    res.json({ data: fields });
  } catch (err) { next(err); }
});

router.post('/custom-fields', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, type, options, required } = req.body;
    const fieldKey = `cf_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const field = await prisma.customField.create({
      data: { name, module, type, options, required: required || false, fieldKey },
    });
    res.status(201).json(field);
  } catch (err) { next(err); }
});

router.put('/custom-fields/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, ...data } = req.body;
    const field = await prisma.customField.update({ where: { id: req.params.id }, data });
    res.json(field);
  } catch (err) { next(err); }
});

router.delete('/custom-fields/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.customField.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── AUDIT LOG ───

router.get('/audit-log', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { action, search, limit = 100 } = req.query;
    let where = {};
    if (action && action !== 'All') where.action = action;
    if (search) where.OR = [
      { module: { contains: search, mode: 'insensitive' } },
      { details: { contains: search, mode: 'insensitive' } },
    ];
    const logs = await prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
    });
    res.json({ data: logs });
  } catch (err) { next(err); }
});

// ─── NOTIFICATIONS ───

router.get('/notifications', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const notifications = await prisma.notification.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ data: notifications });
  } catch (err) { next(err); }
});

router.post('/notifications/mark-read', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids } = req.body;
    if (ids) {
      await prisma.notification.updateMany({ where: { id: { in: ids }, userId: req.userId }, data: { read: true } });
    } else {
      await prisma.notification.updateMany({ where: { userId: req.userId }, data: { read: true } });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── STATS ───

router.get('/stats', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [contacts, leads, deals, accounts, activities, cases, products, quotes, invoices, users, workflows, emails, campaigns, documents] = await Promise.all([
      prisma.contact.count(), prisma.lead.count(), prisma.deal.count(), prisma.account.count(),
      prisma.activity.count(), prisma.case.count(), prisma.product.count(), prisma.quote.count(),
      prisma.invoice.count(), prisma.user.count(), prisma.workflow.count(), prisma.email.count(),
      prisma.campaign.count(), prisma.document.count(),
    ]);
    res.json({ contacts, leads, deals, accounts, activities, cases, products, quotes, invoices, users, workflows, emails, campaigns, documents });
  } catch (err) { next(err); }
});

// ─── DATA EXPORT ───

router.get('/export/:module', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const mod = req.params.module;
    const validModels = ['contact', 'lead', 'deal', 'account', 'activity', 'case', 'product', 'quote', 'invoice', 'email', 'campaign', 'document'];
    if (!validModels.includes(mod)) return res.status(400).json({ error: 'Invalid module' });
    const data = await prisma[mod].findMany();
    res.json({ data });
  } catch (err) { next(err); }
});

// Full backup
router.get('/export', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const backup = {
      exportedAt: new Date().toISOString(),
      contacts: await prisma.contact.findMany(),
      leads: await prisma.lead.findMany(),
      deals: await prisma.deal.findMany(),
      accounts: await prisma.account.findMany(),
      activities: await prisma.activity.findMany(),
      emails: await prisma.email.findMany(),
      cases: await prisma.case.findMany({ include: { comments: true } }),
      documents: await prisma.document.findMany(),
      campaigns: await prisma.campaign.findMany({ include: { recipients: true } }),
      products: await prisma.product.findMany(),
      quotes: await prisma.quote.findMany({ include: { items: true } }),
      invoices: await prisma.invoice.findMany({ include: { items: true } }),
      workflows: await prisma.workflow.findMany(),
      users: (await prisma.user.findMany({ include: { role: true } })).map(({ password, ...u }) => u),
      roles: await prisma.role.findMany({ include: { permissions: true } }),
      customFields: await prisma.customField.findMany(),
    };
    res.json(backup);
  } catch (err) { next(err); }
});

// ─── LEAD SCORING RULES ───

router.get('/scoring-rules', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.leadScoringRule.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: rules });
  } catch (err) { next(err); }
});

router.post('/scoring-rules', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.leadScoringRule.create({ data: req.body });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/scoring-rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.leadScoringRule.update({ where: { id: req.params.id }, data: req.body });
    res.json(rule);
  } catch (err) { next(err); }
});

router.delete('/scoring-rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.leadScoringRule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Batch rescore all leads
router.post('/score-all-leads', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.leadScoringRule.findMany({ where: { active: true } });
    const leads = await prisma.lead.findMany({ where: { status: { notIn: ['Converted', 'Unqualified'] } } });
    let updated = 0;
    for (const lead of leads) {
      let score = 50;
      for (const rule of rules) {
        const val = String(lead[rule.field] || '').toLowerCase();
        const target = rule.value.toLowerCase();
        let match = false;
        switch (rule.operator) {
          case 'equals': match = val === target; break;
          case 'contains': match = val.includes(target); break;
          case 'startsWith': match = val.startsWith(target); break;
          case 'endsWith': match = val.endsWith(target); break;
        }
        if (match) score += rule.points;
      }
      score = Math.max(0, Math.min(100, score));
      if (score !== lead.score) {
        await prisma.lead.update({ where: { id: lead.id }, data: { score } });
        updated++;
      }
    }
    res.json({ success: true, totalLeads: leads.length, updated, rulesApplied: rules.length });
  } catch (err) { next(err); }
});

// ─── ASSIGNMENT RULES ───

router.get('/assignment-rules', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.assignmentRule.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: rules });
  } catch (err) { next(err); }
});

router.post('/assignment-rules', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.assignmentRule.create({ data: req.body });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/assignment-rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.assignmentRule.update({ where: { id: req.params.id }, data: req.body });
    res.json(rule);
  } catch (err) { next(err); }
});

router.delete('/assignment-rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.assignmentRule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── SLA POLICIES ───

router.get('/sla-policies', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const policies = await prisma.slaPolicy.findMany({ orderBy: { priority: 'asc' } });
    res.json({ data: policies });
  } catch (err) { next(err); }
});

router.post('/sla-policies', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const policy = await prisma.slaPolicy.create({ data: req.body });
    res.status(201).json(policy);
  } catch (err) { next(err); }
});

router.put('/sla-policies/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const policy = await prisma.slaPolicy.update({ where: { id: req.params.id }, data: req.body });
    res.json(policy);
  } catch (err) { next(err); }
});

router.delete('/sla-policies/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.slaPolicy.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── BACKGROUND JOBS ───

router.get('/jobs', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const { handlers, getDeadLetterQueue } = require('../jobs/scheduler');
    const jobNames = Object.keys(handlers);
    const dlq = getDeadLetterQueue ? getDeadLetterQueue() : [];
    res.json({
      data: jobNames.map(name => ({
        name,
        description: {
          checkOverdueInvoices: 'Mark overdue invoices and notify',
          recalcForecasts: 'Recalculate forecast totals from deals',
          cleanupAuditLogs: 'Archive old audit log entries',
          cleanupNotifications: 'Remove read notifications older than 30 days',
          checkStaleDeals: 'Flag deals with no activity in 14+ days',
          runScheduledWorkflows: 'Execute scheduled workflow automations',
        }[name] || name,
      })),
      deadLetterQueue: { count: dlq.length, recent: dlq.slice(-10) },
    });
  } catch (err) { next(err); }
});

router.post('/jobs/:name', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const { runJob } = require('../jobs/scheduler');
    const result = await runJob(req.params.name);
    await req.audit({ action: 'update', module: 'admin', details: `Manually ran job: ${req.params.name}` });
    res.json({ success: true, job: req.params.name, result: result || 'completed' });
  } catch (err) {
    if (err.message && err.message.includes('Unknown job')) {
      return res.status(404).json({ error: `Unknown job: ${req.params.name}` });
    }
    next(err);
  }
});

// ─── API KEY MANAGEMENT ───

router.get('/api-keys', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
    // Mask full key, show only prefix
    const safe = keys.map(k => ({ ...k, key: `${k.prefix}...` }));
    res.json({ data: safe });
  } catch (err) { next(err); }
});

router.post('/api-keys', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const crypto = require('crypto');
    const { name, permissions, rateLimit, expiresAt } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const rawKey = `sn_${crypto.randomBytes(32).toString('hex')}`;
    const prefix = rawKey.slice(0, 10);

    const apiKey = await prisma.apiKey.create({
      data: {
        name,
        key: rawKey,
        prefix,
        permissions: permissions || [],
        rateLimit: rateLimit || 1000,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdById: req.userId,
      },
    });

    await req.audit({ action: 'create', module: 'settings', recordId: apiKey.id, details: `Created API key: ${name}` });
    // Return full key ONLY on creation
    res.status(201).json(apiKey);
  } catch (err) { next(err); }
});

router.put('/api-keys/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, permissions, rateLimit, active, expiresAt } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (permissions !== undefined) data.permissions = permissions;
    if (rateLimit !== undefined) data.rateLimit = rateLimit;
    if (active !== undefined) data.active = active;
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;

    const key = await prisma.apiKey.update({ where: { id: req.params.id }, data });
    key.key = `${key.prefix}...`;
    res.json(key);
  } catch (err) { next(err); }
});

router.delete('/api-keys/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.apiKey.delete({ where: { id: req.params.id } });
    await req.audit({ action: 'delete', module: 'settings', details: `Revoked API key` });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── CSV EXPORT ───

router.get('/export-csv/:module', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.params;
    const models = {
      contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
      cases: 'case', products: 'product', activities: 'activity',
    };
    const modelName = models[module];
    if (!modelName) return res.status(400).json({ error: `Unknown module: ${module}` });

    const records = await prisma[modelName].findMany({ take: 10000 });
    if (records.length === 0) return res.status(404).json({ error: 'No records to export' });

    const headers = Object.keys(records[0]).filter(k => k !== 'password');
    const csvRows = [headers.join(',')];
    for (const record of records) {
      const row = headers.map(h => {
        const val = record[h];
        if (val === null || val === undefined) return '';
        const str = val instanceof Date ? val.toISOString() : String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
      });
      csvRows.push(row.join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${module}-export.csv`);
    res.send(csvRows.join('\n'));
  } catch (err) { next(err); }
});

// ─── MULTI-CURRENCY ───

router.get('/currencies', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const currencies = await prisma.currency.findMany({ orderBy: { code: 'asc' } });
    res.json({ data: currencies });
  } catch (err) { next(err); }
});

router.post('/currencies', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { code, name, symbol, exchangeRate, isDefault } = req.body;
    if (!code || !name || !symbol) return res.status(400).json({ error: 'code, name, symbol required' });

    // If setting as default, unset existing default
    if (isDefault) {
      await prisma.currency.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }

    const currency = await prisma.currency.create({
      data: { code: code.toUpperCase(), name, symbol, exchangeRate: exchangeRate || 1.0, isDefault: isDefault || false },
    });
    res.status(201).json(currency);
  } catch (err) { next(err); }
});

router.put('/currencies/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, symbol, exchangeRate, active, isDefault } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (symbol !== undefined) data.symbol = symbol;
    if (exchangeRate !== undefined) data.exchangeRate = exchangeRate;
    if (active !== undefined) data.active = active;
    if (isDefault) {
      await prisma.currency.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      data.isDefault = true;
    }
    const currency = await prisma.currency.update({ where: { id: req.params.id }, data });
    res.json(currency);
  } catch (err) { next(err); }
});

router.delete('/currencies/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const currency = await prisma.currency.findUnique({ where: { id: req.params.id } });
    if (currency?.isDefault) return res.status(400).json({ error: 'Cannot delete default currency' });
    await prisma.currency.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Convert amount between currencies
router.post('/currencies/convert', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { amount, fromCode, toCode } = req.body;
    if (!amount || !fromCode || !toCode) return res.status(400).json({ error: 'amount, fromCode, toCode required' });

    const [from, to] = await Promise.all([
      prisma.currency.findUnique({ where: { code: fromCode.toUpperCase() } }),
      prisma.currency.findUnique({ where: { code: toCode.toUpperCase() } }),
    ]);
    if (!from || !to) return res.status(404).json({ error: 'Currency not found' });

    // Convert via base currency: amount / fromRate * toRate
    const converted = (amount / from.exchangeRate) * to.exchangeRate;
    res.json({ from: fromCode, to: toCode, amount, converted: Math.round(converted * 100) / 100, rate: to.exchangeRate / from.exchangeRate });
  } catch (err) { next(err); }
});

module.exports = router;
