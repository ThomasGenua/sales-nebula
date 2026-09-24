const { createCrudRouter } = require('../utils/crud');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach, reachableWhere, linkRefusal } = require('../middleware/access');
const { currencyContext, sumInBase } = require('../utils/currency');

/**
 * `find(where)` over another module's rows matching `where`, narrowed to the
 * live ones the caller may see; `none` without that module's read permission.
 * The router checks the account alone, so its timeline, stats, relationships
 * and health listed every contact, deal, case and invoice filed on it.
 */
async function readable(req, module, model, where, find, none = []) {
  if (!permits(req, module, 'read')) return none;
  return find(await reachableWhere(req, module, model, where));
}

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
    // Each module's records only as far as the caller may see them (readable).
    router.get('/:id/timeline', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const id = req.params.id;
        const [contacts, deals, activities, cases, invoices, quotes] = await Promise.all([
          readable(req, 'contacts', 'contact', { accountId: id }, where => prisma.contact.findMany({ where, select: { id: true, firstName: true, lastName: true, email: true, title: true } })),
          readable(req, 'deals', 'deal', { accountId: id }, where => prisma.deal.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, name: true, stage: true, value: true, closeDate: true } })),
          readable(req, 'activities', 'activity', { accountId: id }, where => prisma.activity.findMany({ where, orderBy: { date: 'desc' }, take: 20 })),
          readable(req, 'cases', 'case', { accountId: id }, where => prisma.case.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 })),
          readable(req, 'invoices', 'invoice', { accountId: id }, where => prisma.invoice.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, include: { items: true } })),
          readable(req, 'quotes', 'quote', { accountId: id }, where => prisma.quote.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, include: { items: true } })),
        ]);
        res.json({ contacts, deals, activities, cases, invoices, quotes });
      } catch (err) { next(err); }
    });

    // GET /api/accounts/:id/stats
    // Counted from the records the caller may see (readable), not every one.
    router.get('/:id/stats', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const id = req.params.id;
        const [contacts, deals, cases, invoices] = await Promise.all([
          readable(req, 'contacts', 'contact', { accountId: id }, where => prisma.contact.count({ where }), 0),
          readable(req, 'deals', 'deal', { accountId: id }, where => prisma.deal.findMany({ where, select: { stage: true, value: true, currency: true } })),
          readable(req, 'cases', 'case', { accountId: id }, where => prisma.case.findMany({ where, select: { status: true } })),
          // select and include are mutually exclusive in Prisma; asking for both
          // made this whole endpoint throw, so account stats never returned.
          readable(req, 'invoices', 'invoice', { accountId: id }, where => prisma.invoice.findMany({ where, include: { items: true } })),
        ]);

        const openDeals = deals.filter(d => d.stage !== 'Closed Won' && d.stage !== 'Closed Lost');
        const wonDeals = deals.filter(d => d.stage === 'Closed Won');
        const ctx = await currencyContext(prisma);

        res.json({
          currency: ctx.base,
          contacts,
          totalDeals: deals.length,
          openDeals: openDeals.length,
          pipelineValue: sumInBase(openDeals, ctx),
          wonValue: sumInBase(wonDeals, ctx),
          winRate: (wonDeals.length + deals.filter(d => d.stage === 'Closed Lost').length) > 0
            ? Math.round(wonDeals.length / (wonDeals.length + deals.filter(d => d.stage === 'Closed Lost').length) * 100) : 0,
          openCases: cases.filter(c => c.status !== 'Resolved' && c.status !== 'Closed').length,
          totalRevenue: sumInBase(wonDeals, ctx),
        });
      } catch (err) { next(err); }
    });

    // POST /api/accounts/:id/merge is further down. An unguarded copy here was
    // registered first, so it answered and the guarded one never ran.

    // POST /api/accounts/:id/clone
    router.post('/:id/clone', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        // A live account, as GET /:id answers for. A deleted one was cloned,
        // deletedAt and all, into a deleted copy.
        const source = await prisma.account.findFirst({ where: { id: req.params.id, deletedAt: null } });
        if (!source) return res.status(404).json({ error: 'Not found' });

        const { id, createdAt, updatedAt, deletedAt, ...data } = source;
        data.name = `${data.name} (Copy)`;
        // The copy is the caller's, as a cloned deal is. It kept the source's
        // owner and creator, so it landed in another rep's accounts.
        data.ownerId = req.userId;
        data.createdById = req.userId;

        // The copy links only to records the caller can see; it took the
        // source's links unchecked, so it could be filed under an account
        // hidden from them. A hidden link is dropped rather than refusing the
        // clone: the caller did not send it and cannot change it. linkRefusal
        // passes parentId (no model is called `parent`), so the parent is
        // looked up as /:id/hierarchy looks it up.
        const seen = new Map();
        for (const key of Object.keys(data)) {
          if (await linkRefusal(req, 'account', { [key]: data[key] }, null, seen)) data[key] = null;
        }
        if (data.parentId && !(await prisma.account.findFirst({ where: await reachableWhere(req, 'accounts', 'account', { id: data.parentId }), select: { id: true } }))) {
          data.parentId = null;
        }

        const clone = await prisma.account.create({ data });
        res.status(201).json(clone);
      } catch (err) { next(err); }
    });
  },
});

// Account relationship graph
// Each module's records only as far as the caller may see them (readable).
router.get('/:id/relationships', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = req.params.id;
    const [contacts, deals, cases, activities, invoices, quotes, contracts, subscriptions, assets, opportunities] = await Promise.all([
      readable(req, 'contacts', 'contact', { accountId: id }, where => prisma.contact.findMany({ where, select: { id: true, firstName: true, lastName: true, title: true, email: true } })),
      readable(req, 'deals', 'deal', { accountId: id }, where => prisma.deal.findMany({ where, select: { id: true, name: true, value: true, stage: true, probability: true } })),
      readable(req, 'cases', 'case', { accountId: id }, where => prisma.case.findMany({ where, select: { id: true, subject: true, status: true, priority: true, createdAt: true } })),
      readable(req, 'activities', 'activity', { accountId: id }, where => prisma.activity.findMany({ where, select: { id: true, subject: true, type: true, status: true, dueDate: true }, take: 20, orderBy: { createdAt: 'desc' } })),
      readable(req, 'invoices', 'invoice', { accountId: id }, where => prisma.invoice.findMany({ where, select: { id: true, invoiceNumber: true, totalAmount: true, status: true } })),
      readable(req, 'quotes', 'quote', { accountId: id }, where => prisma.quote.findMany({ where, select: { id: true, name: true, totalAmount: true, status: true } })),
      readable(req, 'contracts', 'contract', { accountId: id }, where => prisma.contract.findMany({ where, select: { id: true, name: true, status: true, value: true, endDate: true } })),
      readable(req, 'subscriptions', 'subscription', { accountId: id }, where => prisma.subscription.findMany({ where, select: { id: true, status: true, totalPrice: true, endDate: true } })),
      readable(req, 'assets', 'asset', { accountId: id }, where => prisma.asset.findMany({ where, select: { id: true, name: true, status: true } })).catch(() => []),
      readable(req, 'deals', 'deal', { accountId: id, stage: { not: 'Closed Lost' } }, where => prisma.deal.findMany({ where, select: { id: true, name: true, value: true } })),
    ]);
    res.json({ contacts, deals, cases, activities, invoices, quotes, contracts, subscriptions, assets, openOpportunities: opportunities });
  } catch (err) { next(err); }
});

// Account health score
// Scored from the records the caller may see (readable), not every one.
router.get('/:id/health', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = req.params.id;
    const [account, contacts, deals, cases, activities] = await Promise.all([
      prisma.account.findFirst({ where: { id, deletedAt: null }, select: { id: true } }),
      readable(req, 'contacts', 'contact', { accountId: id }, where => prisma.contact.count({ where }), 0),
      readable(req, 'deals', 'deal', { accountId: id }, where => prisma.deal.findMany({ where, select: { stage: true, value: true, currency: true } })),
      readable(req, 'cases', 'case', { accountId: id, createdAt: { gte: new Date(Date.now() - 90 * 86400000) } }, where => prisma.case.findMany({ where, select: { priority: true, status: true } })),
      readable(req, 'activities', 'activity', { accountId: id, createdAt: { gte: new Date(Date.now() - 30 * 86400000) } }, where => prisma.activity.count({ where }), 0),
    ]);
    // The account was read and never checked, so any id, a deleted account's
    // included, was scored as an account with nothing on it.
    if (!account) return res.status(404).json({ error: 'Not found' });
    const ctx = await currencyContext(prisma);
    let score = 50;
    if (contacts > 3) score += 10; else if (contacts === 0) score -= 15;
    const wonDeals = deals.filter(d => d.stage === 'Closed Won');
    if (wonDeals.length > 0) score += 15;
    const openDeals = deals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
    if (openDeals.length > 0) score += 10;
    // Open ones, as /:id/stats counts them: a resolved case was still critical here.
    const criticalCases = cases.filter(c => c.priority === 'Critical' && !['Resolved', 'Closed'].includes(c.status));
    if (criticalCases.length > 0) score -= 20;
    if (activities > 5) score += 15; else if (activities === 0) score -= 10;
    score = Math.max(0, Math.min(100, score));
    const tier = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'At Risk' : 'Critical';
    res.json({ score, tier, factors: { contacts, totalDeals: deals.length, wonDeals: wonDeals.length, openDeals: openDeals.length, recentCases: cases.length, criticalCases: criticalCases.length, recentActivities: activities, totalRevenue: sumInBase(wonDeals, ctx) } });
  } catch (err) { next(err); }
});

// Account merge
router.post('/:id/merge', authenticate, requirePermission('accounts', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // `mergeId` is what the unguarded copy took; its callers still land here.
    const mergeFromId = req.body.mergeFromId ?? req.body.mergeId;
    if (!mergeFromId || typeof mergeFromId !== 'string') return res.status(400).json({ error: 'mergeFromId required' });
    // Into itself, a merge would only delete the account.
    if (mergeFromId === req.params.id) return res.status(400).json({ error: 'Cannot merge account into itself' });
    // The router checks :id alone. This account gives up its records and is
    // deleted, so the caller needs the row access DELETE asks for.
    if (!(await canReach(req, 'accounts', 'account', mergeFromId, 'Full'))) {
      return res.status(404).json({ error: 'Account not found' });
    }
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
// Only accounts the caller can see, and a parent they cannot comes back null.
// This listed any account's parent, children and siblings, with industry and
// revenue, to anyone who could open one of them.
router.get('/:id/hierarchy', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A live account, as GET /:id answers for; a deleted one still answered.
    const account = await prisma.account.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true, name: true, parentId: true } });
    if (!account) return res.status(404).json({ error: 'Not found' });
    const visible = where => reachableWhere(req, 'accounts', 'account', where);
    const children = await prisma.account.findMany({ where: await visible({ parentId: account.id }), select: { id: true, name: true, industry: true, annualRevenue: true } });
    let parent = null;
    if (account.parentId) parent = await prisma.account.findFirst({ where: await visible({ id: account.parentId }), select: { id: true, name: true } });
    const siblings = account.parentId ? await prisma.account.findMany({ where: await visible({ parentId: account.parentId, id: { not: account.id } }), select: { id: true, name: true } }) : [];
    res.json({ account, parent, children, siblings });
  } catch (err) { next(err); }
});

module.exports = router;
