const { createCrudRouter } = require('../utils/crud');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = createCrudRouter('account', 'accounts', {
  include: {
    contacts: { select: { id: true, firstName: true, lastName: true, email: true, title: true } },
    deals: { select: { id: true, name: true, stage: true, value: true } },
    customValues: { include: { customField: true } },
  },
  searchFilter: (q) => ({ name: { contains: q, mode: 'insensitive' } }),
  validate: (data) => {
    const errors = {};
    if (!data.name?.trim()) errors.name = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  beforeCreate: (data) => ({
    ...data,
    revenue: parseFloat(data.revenue) || 0,
    employees: parseInt(data.employees) || 0,
    rating: parseInt(data.rating) || 0,
  }),
  customRoutes: (router) => {
    // GET /api/accounts/:id/timeline
    router.get('/:id/timeline', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const id = req.params.id;
        const [contacts, deals, activities, cases, invoices, quotes] = await Promise.all([
          prisma.contact.findMany({ where: { accountId: id }, select: { id: true, firstName: true, lastName: true, email: true, title: true } }),
          prisma.deal.findMany({ where: { accountId: id }, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, name: true, stage: true, value: true, closeDate: true } }),
          prisma.activity.findMany({ where: { accountId: id }, orderBy: { date: 'desc' }, take: 20 }),
          prisma.case.findMany({ where: { accountId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
          prisma.invoice.findMany({ where: { accountId: id }, orderBy: { createdAt: 'desc' }, take: 10, include: { items: true } }),
          prisma.quote.findMany({ where: { accountId: id }, orderBy: { createdAt: 'desc' }, take: 10, include: { items: true } }),
        ]);
        res.json({ contacts, deals, activities, cases, invoices, quotes });
      } catch (err) { next(err); }
    });

    // GET /api/accounts/:id/stats
    router.get('/:id/stats', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const id = req.params.id;
        const [contacts, deals, cases, invoices] = await Promise.all([
          prisma.contact.count({ where: { accountId: id } }),
          prisma.deal.findMany({ where: { accountId: id }, select: { stage: true, value: true } }),
          prisma.case.findMany({ where: { accountId: id }, select: { status: true } }),
          prisma.invoice.findMany({ where: { accountId: id }, select: { status: true }, include: { items: true } }),
        ]);

        const openDeals = deals.filter(d => d.stage !== 'Closed Won' && d.stage !== 'Closed Lost');
        const wonDeals = deals.filter(d => d.stage === 'Closed Won');

        res.json({
          contacts,
          totalDeals: deals.length,
          openDeals: openDeals.length,
          pipelineValue: openDeals.reduce((s, d) => s + d.value, 0),
          wonValue: wonDeals.reduce((s, d) => s + d.value, 0),
          winRate: (wonDeals.length + deals.filter(d => d.stage === 'Closed Lost').length) > 0
            ? Math.round(wonDeals.length / (wonDeals.length + deals.filter(d => d.stage === 'Closed Lost').length) * 100) : 0,
          openCases: cases.filter(c => c.status !== 'Resolved' && c.status !== 'Closed').length,
          totalRevenue: wonDeals.reduce((s, d) => s + d.value, 0),
        });
      } catch (err) { next(err); }
    });

    // POST /api/accounts/:id/merge - Merge duplicate account into primary
    router.post('/:id/merge', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const primaryId = req.params.id;
        const { mergeId } = req.body;
        if (!mergeId) return res.status(400).json({ error: 'mergeId required' });
        if (primaryId === mergeId) return res.status(400).json({ error: 'Cannot merge account into itself' });

        const [primary, duplicate] = await Promise.all([
          prisma.account.findUnique({ where: { id: primaryId } }),
          prisma.account.findUnique({ where: { id: mergeId } }),
        ]);
        if (!primary || !duplicate) return res.status(404).json({ error: 'One or both accounts not found' });

        // Move all child records to primary
        await Promise.all([
          prisma.contact.updateMany({ where: { accountId: mergeId }, data: { accountId: primaryId } }),
          prisma.deal.updateMany({ where: { accountId: mergeId }, data: { accountId: primaryId } }),
          prisma.case.updateMany({ where: { accountId: mergeId }, data: { accountId: primaryId } }),
          prisma.invoice.updateMany({ where: { accountId: mergeId }, data: { accountId: primaryId } }),
          prisma.activity.updateMany({ where: { accountId: mergeId }, data: { accountId: primaryId } }),
        ]);

        // Fill empty fields on primary from duplicate
        const fillFields = {};
        ['industry', 'website', 'phone', 'address', 'city', 'state', 'country', 'description', 'billing'].forEach(f => {
          if (!primary[f] && duplicate[f]) fillFields[f] = duplicate[f];
        });
        // Sum numeric fields
        fillFields.revenue = (primary.revenue || 0) + (duplicate.revenue || 0);
        fillFields.employees = Math.max(primary.employees || 0, duplicate.employees || 0);

        await prisma.account.update({ where: { id: primaryId }, data: fillFields });

        // Delete the duplicate
        await prisma.account.delete({ where: { id: mergeId } });

        await req.audit({ action: 'update', module: 'accounts', recordId: primaryId, details: `Merged account ${duplicate.name} into ${primary.name}` });

        const result = await prisma.account.findUnique({ where: { id: primaryId }, include: {
          contacts: { select: { id: true, firstName: true, lastName: true } },
          deals: { select: { id: true, name: true, stage: true, value: true } },
        }});
        res.json(result);
      } catch (err) { next(err); }
    });

    // POST /api/accounts/:id/clone
    router.post('/:id/clone', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const source = await prisma.account.findUnique({ where: { id: req.params.id } });
        if (!source) return res.status(404).json({ error: 'Not found' });

        const { id, createdAt, updatedAt, ...data } = source;
        data.name = `${data.name} (Copy)`;

        const clone = await prisma.account.create({ data });
        res.status(201).json(clone);
      } catch (err) { next(err); }
    });
  },
});

// Account relationship graph
router.get('/:id/relationships', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = req.params.id;
    const [contacts, deals, cases, activities, invoices, quotes, contracts, subscriptions, assets, opportunities] = await Promise.all([
      prisma.contact.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, firstName: true, lastName: true, title: true, email: true } }),
      prisma.deal.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, name: true, value: true, stage: true, probability: true } }),
      prisma.case.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, subject: true, status: true, priority: true, createdAt: true } }),
      prisma.activity.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, subject: true, type: true, status: true, dueDate: true }, take: 20, orderBy: { createdAt: 'desc' } }),
      prisma.invoice.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, invoiceNumber: true, totalAmount: true, status: true } }),
      prisma.quote.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, name: true, totalAmount: true, status: true } }),
      prisma.contract.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, name: true, status: true, value: true, endDate: true } }),
      prisma.subscription.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, status: true, totalPrice: true, endDate: true } }),
      prisma.asset.findMany({ where: { accountId: id, deletedAt: null }, select: { id: true, name: true, status: true } }).catch(() => []),
      prisma.deal.findMany({ where: { accountId: id, deletedAt: null, stage: { not: 'Closed Lost' } }, select: { id: true, name: true, value: true } }),
    ]);
    res.json({ contacts, deals, cases, activities, invoices, quotes, contracts, subscriptions, assets, openOpportunities: opportunities });
  } catch (err) { next(err); }
});

// Account health score
router.get('/:id/health', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = req.params.id;
    const [account, contacts, deals, cases, activities] = await Promise.all([
      prisma.account.findUnique({ where: { id } }),
      prisma.contact.count({ where: { accountId: id, deletedAt: null } }),
      prisma.deal.findMany({ where: { accountId: id, deletedAt: null }, select: { stage: true, value: true } }),
      prisma.case.findMany({ where: { accountId: id, deletedAt: null, createdAt: { gte: new Date(Date.now() - 90 * 86400000) } }, select: { priority: true, status: true } }),
      prisma.activity.count({ where: { accountId: id, deletedAt: null, createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } }),
    ]);
    let score = 50;
    if (contacts > 3) score += 10; else if (contacts === 0) score -= 15;
    const wonDeals = deals.filter(d => d.stage === 'Closed Won');
    if (wonDeals.length > 0) score += 15;
    const openDeals = deals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
    if (openDeals.length > 0) score += 10;
    const criticalCases = cases.filter(c => c.priority === 'Critical' && c.status !== 'Closed');
    if (criticalCases.length > 0) score -= 20;
    if (activities > 5) score += 15; else if (activities === 0) score -= 10;
    score = Math.max(0, Math.min(100, score));
    const tier = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'At Risk' : 'Critical';
    res.json({ score, tier, factors: { contacts, totalDeals: deals.length, wonDeals: wonDeals.length, openDeals: openDeals.length, recentCases: cases.length, criticalCases: criticalCases.length, recentActivities: activities, totalRevenue: wonDeals.reduce((s, d) => s + (d.value || 0), 0) } });
  } catch (err) { next(err); }
});

// Account merge
router.post('/:id/merge', authenticate, requirePermission('accounts', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { mergeFromId } = req.body;
    if (!mergeFromId) return res.status(400).json({ error: 'mergeFromId required' });
    const [primary, secondary] = await Promise.all([
      prisma.account.findUnique({ where: { id: req.params.id } }),
      prisma.account.findUnique({ where: { id: mergeFromId } }),
    ]);
    if (!primary || !secondary) return res.status(404).json({ error: 'Account not found' });
    // Transfer all related records
    await Promise.all([
      prisma.contact.updateMany({ where: { accountId: mergeFromId }, data: { accountId: primary.id } }),
      prisma.deal.updateMany({ where: { accountId: mergeFromId }, data: { accountId: primary.id } }),
      prisma.case.updateMany({ where: { accountId: mergeFromId }, data: { accountId: primary.id } }),
      prisma.activity.updateMany({ where: { accountId: mergeFromId }, data: { accountId: primary.id } }),
      prisma.invoice.updateMany({ where: { accountId: mergeFromId }, data: { accountId: primary.id } }),
      prisma.contract.updateMany({ where: { accountId: mergeFromId }, data: { accountId: primary.id } }),
    ]);
    // Fill blank fields from secondary
    const updates = {};
    for (const field of ['phone','website','industry','billingCity','billingState','billingCountry','description','annualRevenue']) {
      if (!primary[field] && secondary[field]) updates[field] = secondary[field];
    }
    if (Object.keys(updates).length) await prisma.account.update({ where: { id: primary.id }, data: updates });
    await prisma.account.update({ where: { id: mergeFromId }, data: { deletedAt: new Date() } });
    await req.audit({ action: 'merge', module: 'accounts', recordId: primary.id, details: `Merged ${mergeFromId} into ${primary.id}` });
    res.json({ merged: true, primaryId: primary.id, mergedFromId: mergeFromId });
  } catch (err) { next(err); }
});

// Account hierarchy
router.get('/:id/hierarchy', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, parentId: true } });
    if (!account) return res.status(404).json({ error: 'Not found' });
    const children = await prisma.account.findMany({ where: { parentId: account.id, deletedAt: null }, select: { id: true, name: true, industry: true, annualRevenue: true } });
    let parent = null;
    if (account.parentId) parent = await prisma.account.findUnique({ where: { id: account.parentId }, select: { id: true, name: true } });
    const siblings = account.parentId ? await prisma.account.findMany({ where: { parentId: account.parentId, id: { not: account.id }, deletedAt: null }, select: { id: true, name: true } }) : [];
    res.json({ account, parent, children, siblings });
  } catch (err) { next(err); }
});

module.exports = router;
