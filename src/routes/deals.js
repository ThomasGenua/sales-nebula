const { createCrudRouter } = require('../utils/crud');
const { requirePermission, permits } = require('../middleware/auth');
const { visibleWhere } = require('../middleware/rowSecurity');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { buildApprovalSteps, notifyApprovers, meetsEntryConditions } = require('../services/approvals');
const { currencyContext, sumInBase, resolveDealCurrency } = require('../utils/currency');

/**
 * `find(where)` over another module's rows matching `where`, narrowed to the
 * live ones the caller may see; `none` without that module's read permission.
 * The router checks the deal alone, so its timeline listed every activity,
 * email, case, quote and invoice filed on it.
 */
async function readable(req, module, model, where, find, none = []) {
  if (!permits(req, module, 'read')) return none;
  return find(await reachableWhere(req, module, model, where));
}

module.exports = createCrudRouter('deal', 'deals', {
  include: {
    account: { select: { id: true, name: true, industry: true } },
    contact: { select: { id: true, firstName: true, lastName: true, email: true } },
    owner: { select: { id: true, firstName: true, lastName: true } },
    customValues: { include: { customField: true } },
  },
  searchFilter: (q) => ({ name: { contains: q, mode: 'insensitive' } }),
  validate: (data) => {
    const errors = {};
    if (!data.name?.trim()) errors.name = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  orderBy: { updatedAt: 'desc' },
  // A deal's value is in its own currency; an unknown or inactive code is a
  // 400, and none at all means the default currency.
  beforeCreate: async (data, req) => ({ ...data, currency: await resolveDealCurrency(req.app.locals.prisma, data.currency) }),
  afterUpdate: async (record, req) => {
    // Track stage changes
    const prisma = req.app.locals.prisma;
    const oldStage = req._oldDealStage;
    if (oldStage && oldStage !== record.stage) {
      // Calculate days in old stage
      const lastHistory = await prisma.dealStageHistory.findFirst({
        where: { dealId: record.id },
        orderBy: { createdAt: 'desc' },
      });
      const duration = lastHistory
        ? Math.round((Date.now() - lastHistory.createdAt.getTime()) / 86400000)
        : null;

      await prisma.dealStageHistory.create({
        data: {
          dealId: record.id,
          fromStage: oldStage,
          toStage: record.stage,
          changedById: req.userId,
          duration,
        },
      });

      if (req.app.locals.emit?.dealStageChanged) {
        req.app.locals.emit.dealStageChanged(record, oldStage, record.stage);
      }
    }
  },
  beforeUpdate: async (data, req) => {
    if (data.currency !== undefined) data = { ...data, currency: await resolveDealCurrency(req.app.locals.prisma, data.currency) };
    // Store old stage for afterUpdate comparison
    if (data.stage) {
      const prisma = req.app.locals.prisma;
      const current = await prisma.deal.findUnique({ where: { id: req.params.id }, select: { stage: true } });
      req._oldDealStage = current?.stage;
    }
    return data;
  },
  customRoutes: (router) => {
    // GET /api/deals/currencies - What the deal form may offer
    router.get('/currencies', async (req, res, next) => {
      try {
        const ctx = await currencyContext(req.app.locals.prisma);
        res.json({
          base: ctx.base,
          data: ctx.currencies.filter(c => c.active).map(({ code, name, symbol, isDefault }) => ({ code, name, symbol, isDefault })),
        });
      } catch (err) { next(err); }
    });

    // GET /api/deals/pipeline - Pipeline summary stats
    // Amounts are in the default currency. This read every deal, deleted and
    // other people's included, and added values across currencies.
    router.get('/stats/pipeline', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const [deals, ctx] = await Promise.all([
          prisma.deal.findMany({ where: await visibleWhere(req, 'deals', 'deal'), select: { stage: true, value: true, currency: true } }),
          currencyContext(prisma),
        ]);
        const stages = ['Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
        const pipeline = stages.map(stage => ({
          stage,
          count: deals.filter(d => d.stage === stage).length,
          value: sumInBase(deals.filter(d => d.stage === stage), ctx),
        }));
        const open = deals.filter(d => d.stage !== 'Closed Won' && d.stage !== 'Closed Lost');
        const won = deals.filter(d => d.stage === 'Closed Won');
        const lost = deals.filter(d => d.stage === 'Closed Lost');
        res.json({
          currency: ctx.base,
          pipeline,
          summary: {
            totalOpen: open.length,
            totalValue: sumInBase(open, ctx),
            wonCount: won.length,
            wonValue: sumInBase(won, ctx),
            lostCount: lost.length,
            winRate: (won.length + lost.length) > 0 ? Math.round(won.length / (won.length + lost.length) * 100) : 0,
            avgDealSize: open.length > 0 ? Math.round(sumInBase(open, ctx) / open.length) : 0,
          },
        });
      } catch (err) { next(err); }
    });

    // GET /api/deals/:id/timeline
    // Each module's records only as far as the caller may see them (readable).
    router.get('/:id/timeline', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const id = req.params.id;
        const [activities, emails, cases, quotes, invoices, stageHistory] = await Promise.all([
          readable(req, 'activities', 'activity', { dealId: id }, where => prisma.activity.findMany({ where, orderBy: { date: 'desc' }, take: 20 })),
          readable(req, 'emails', 'email', { dealId: id }, where => prisma.email.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20 })),
          readable(req, 'cases', 'case', { dealId: id }, where => prisma.case.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 })),
          readable(req, 'quotes', 'quote', { dealId: id }, where => prisma.quote.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, include: { items: true } })),
          readable(req, 'invoices', 'invoice', { quote: { dealId: id } }, where => prisma.invoice.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, include: { items: true } })),
          prisma.dealStageHistory.findMany({ where: { dealId: id }, orderBy: { createdAt: 'asc' } }),
        ]);
        res.json({ activities, emails, cases, quotes, invoices, stageHistory });
      } catch (err) { next(err); }
    });

    // GET /api/deals/stats/velocity - Average time in each stage
    // Over the deals the caller can see. This averaged every deal's history.
    router.get('/stats/velocity', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const history = await prisma.dealStageHistory.findMany({
          where: { duration: { not: null }, deal: { is: await visibleWhere(req, 'deals', 'deal') } },
          select: { fromStage: true, duration: true },
        });

        const stages = {};
        history.forEach(h => {
          if (!h.fromStage) return;
          if (!stages[h.fromStage]) stages[h.fromStage] = { total: 0, count: 0 };
          stages[h.fromStage].total += h.duration;
          stages[h.fromStage].count++;
        });

        const velocity = Object.entries(stages).map(([stage, data]) => ({
          stage,
          avgDays: Math.round(data.total / data.count),
          count: data.count,
        }));

        res.json({ data: velocity });
      } catch (err) { next(err); }
    });

    // GET /api/deals/:id/line-items
    router.get('/:id/line-items', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const items = await prisma.dealLineItem.findMany({
          where: { dealId: req.params.id },
          include: { product: { select: { id: true, name: true, sku: true } } },
          orderBy: { sortOrder: 'asc' },
        });
        const subtotal = items.reduce((s, i) => s + i.total, 0);
        res.json({ data: items, subtotal });
      } catch (err) { next(err); }
    });

    // POST /api/deals/:id/line-items
    router.post('/:id/line-items', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { productId, name, quantity = 1, price, discount = 0 } = req.body;
        // Only a live product the caller can see. The id was stored as sent,
        // so a deleted or hidden product went on the deal, its name and SKU
        // coming back in the response.
        const linkProblem = await linkRefusal(req, 'dealLineItem', { productId });
        if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
        const total = price * quantity * (1 - discount / 100);
        const count = await prisma.dealLineItem.count({ where: { dealId: req.params.id } });
        const item = await prisma.dealLineItem.create({
          data: { dealId: req.params.id, productId, name, quantity, price, discount, total, sortOrder: count },
          include: { product: { select: { id: true, name: true, sku: true } } },
        });

        // Update deal value to match line items total
        const allItems = await prisma.dealLineItem.findMany({ where: { dealId: req.params.id } });
        const dealTotal = allItems.reduce((s, i) => s + i.total, 0);
        await prisma.deal.update({ where: { id: req.params.id }, data: { value: dealTotal } });

        res.status(201).json(item);
      } catch (err) { next(err); }
    });

    // DELETE /api/deals/:id/line-items/:itemId
    router.delete('/:id/line-items/:itemId', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        // Only an item on this deal. The router checks the deal in the path;
        // the item id alone reached any deal's line items.
        const { count } = await prisma.dealLineItem.deleteMany({ where: { id: req.params.itemId, dealId: req.params.id } });
        if (!count) return res.status(404).json({ error: 'Not found' });

        // Recalculate deal value
        const allItems = await prisma.dealLineItem.findMany({ where: { dealId: req.params.id } });
        const dealTotal = allItems.reduce((s, i) => s + i.total, 0);
        await prisma.deal.update({ where: { id: req.params.id }, data: { value: dealTotal } });

        res.json({ success: true });
      } catch (err) { next(err); }
    });

    // POST /api/deals/:id/clone
    router.post('/:id/clone', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        // A live deal, as GET /:id answers for. A deleted one was cloned,
        // deletedAt and all, into a deleted copy.
        const source = await prisma.deal.findFirst({
          where: { id: req.params.id, deletedAt: null },
          include: { lineItems: true },
        });
        if (!source) return res.status(404).json({ error: 'Not found' });

        const { id, createdAt, updatedAt, deletedAt, lineItems, stageHistory, ...data } = source;
        // The copy links only to records the caller can see: it took the
        // source's account, contact and partner, and its items' products,
        // unchecked. A hidden link is dropped rather than refusing the clone,
        // as for an account: the caller did not send it and cannot change it.
        const seen = new Map();
        for (const key of Object.keys(data)) {
          if (await linkRefusal(req, 'deal', { [key]: data[key] }, null, seen)) data[key] = null;
        }
        for (const item of lineItems) {
          if (await linkRefusal(req, 'dealLineItem', { productId: item.productId }, null, seen)) item.productId = null;
        }
        data.name = `${data.name} (Copy)`;
        data.stage = 'Qualification';
        data.closeDate = new Date(Date.now() + 30 * 86400000); // 30 days out
        data.ownerId = req.userId;
        // Prisma refuses a bare null for a Json column; left out, it stays NULL.
        if (data.competitors === null) delete data.competitors;

        const clone = await prisma.deal.create({
          data: {
            ...data,
            lineItems: lineItems.length > 0 ? {
              create: lineItems.map(({ id, dealId, createdAt, ...item }) => item),
            } : undefined,
          },
          include: {
            account: { select: { id: true, name: true } },
            lineItems: true,
          },
        });
        res.status(201).json(clone);
      } catch (err) { next(err); }
    });

    // GET /api/deals/:id/competitors
    router.get('/:id/competitors', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const deal = await prisma.deal.findUnique({ where: { id: req.params.id } });
        if (!deal) return res.status(404).json({ error: 'Not found' });
        // Competitors stored as JSON on the deal
        res.json({ data: deal.competitors || [] });
      } catch (err) { next(err); }
    });

    // PUT /api/deals/:id/competitors
    router.put('/:id/competitors', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { competitors } = req.body; // Array of {name, strengths, weaknesses, threat}
        const deal = await prisma.deal.update({
          where: { id: req.params.id },
          data: { competitors },
        });
        res.json({ data: deal.competitors });
      } catch (err) { next(err); }
    });

    // GET /api/deals/stats/aging - Deal aging (days in current stage)
    router.get('/stats/aging', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const deals = await prisma.deal.findMany({
          where: await visibleWhere(req, 'deals', 'deal', { stage: { notIn: ['Closed Won', 'Closed Lost'] } }),
          select: { id: true, name: true, stage: true, value: true, currency: true, updatedAt: true, createdAt: true, account: { select: { name: true } } },
        });

        const now = Date.now();
        const aging = deals.map(d => ({
          id: d.id,
          name: d.name,
          account: d.account?.name,
          stage: d.stage,
          value: d.value,
          currency: d.currency,
          daysInStage: Math.round((now - d.updatedAt.getTime()) / 86400000),
          totalAge: Math.round((now - d.createdAt.getTime()) / 86400000),
        })).sort((a, b) => b.daysInStage - a.daysInStage);

        const staleDeals = aging.filter(d => d.daysInStage > 30);
        const atRisk = aging.filter(d => d.daysInStage > 14 && d.daysInStage <= 30);

        res.json({ data: aging, staleDeals: staleDeals.length, atRisk: atRisk.length, total: aging.length });
      } catch (err) { next(err); }
    });

    // GET /api/deals/stats/win-loss - Win/loss analysis
    router.get('/stats/win-loss', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { period } = req.query; // e.g. 'month', 'quarter', 'year'
        const now = new Date();
        let dateFilter = {};

        if (period === 'month') {
          dateFilter = { gte: new Date(now.getFullYear(), now.getMonth(), 1) };
        } else if (period === 'quarter') {
          dateFilter = { gte: new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1) };
        } else if (period === 'year') {
          dateFilter = { gte: new Date(now.getFullYear(), 0, 1) };
        }

        const where = dateFilter.gte ? { closeDate: dateFilter, stage: { in: ['Closed Won', 'Closed Lost'] } } : { stage: { in: ['Closed Won', 'Closed Lost'] } };
        const ctx = await currencyContext(prisma);
        const deals = await prisma.deal.findMany({
          where: await visibleWhere(req, 'deals', 'deal', where),
          select: { id: true, name: true, stage: true, value: true, currency: true, closeDate: true, lossReason: true, source: true,
            account: { select: { name: true, industry: true } },
            owner: { select: { id: true, firstName: true, lastName: true } },
          },
        });

        const won = deals.filter(d => d.stage === 'Closed Won');
        const lost = deals.filter(d => d.stage === 'Closed Lost');

        // Loss reasons breakdown
        const lossReasons = {};
        lost.forEach(d => {
          const reason = d.lossReason || 'Unknown';
          lossReasons[reason] = (lossReasons[reason] || 0) + 1;
        });

        // Win rate by rep
        const byRep = {};
        deals.forEach(d => {
          const key = d.owner?.id || 'unassigned';
          if (!byRep[key]) byRep[key] = { user: d.owner, won: 0, lost: 0, wonValue: 0, lostValue: 0 };
          if (d.stage === 'Closed Won') { byRep[key].won++; byRep[key].wonValue += ctx.toBase(d.value, d.currency); }
          else { byRep[key].lost++; byRep[key].lostValue += ctx.toBase(d.value, d.currency); }
        });

        Object.values(byRep).forEach(r => {
          r.winRate = (r.won + r.lost) > 0 ? Math.round(r.won / (r.won + r.lost) * 100) : 0;
        });

        res.json({
          currency: ctx.base,
          totalWon: won.length, totalLost: lost.length,
          winRate: (won.length + lost.length) > 0 ? Math.round(won.length / (won.length + lost.length) * 100) : 0,
          wonValue: sumInBase(won, ctx),
          lostValue: sumInBase(lost, ctx),
          avgWonDealSize: won.length > 0 ? Math.round(sumInBase(won, ctx) / won.length) : 0,
          lossReasons,
          byRep: Object.values(byRep),
        });
      } catch (err) { next(err); }
    });

    // POST /api/deals/:id/submit - Submit deal for approval
    router.post('/:id/submit', requirePermission('deals', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        // Only a deal the submitter can see; this took any deal id.
        const deal = await prisma.deal.findFirst({ where: await visibleWhere(req, 'deals', 'deal', { id: req.params.id }) });
        if (!deal) return res.status(404).json({ error: 'Not found' });

        // The first active process, oldest first, whose entry conditions the
        // deal meets. This took whichever active process the database
        // returned first, conditions unread.
        const processes = await prisma.approvalProcess.findMany({
          where: { module: 'deals', active: true },
          include: { steps: { orderBy: { stepOrder: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        });
        if (!processes.length) {
          return res.status(400).json({ error: 'No active approval process configured for deals' });
        }
        const process = processes.find(p => meetsEntryConditions(p, deal));
        if (!process) return res.status(400).json({ error: 'This deal meets the entry conditions of no active approval process' });
        if (!process.steps.length) return res.status(400).json({ error: 'Approval process has no steps' });
        const open = await prisma.approvalRequest.findFirst({ where: { processId: process.id, recordId: deal.id, status: 'Pending' } });
        if (open) return res.status(409).json({ error: 'This deal is already awaiting approval', requestId: open.id });
        // Every candidate for every step, never the submitter (services/approvals).
        const stepRows = await buildApprovalSteps(prisma, process.steps, req.user);

        // Create approval request
        const request = await prisma.approvalRequest.create({
          data: {
            processId: process.id,
            recordId: deal.id,
            dealId: deal.id,
            module: 'deals',
            submittedById: req.userId,
            status: 'Pending',
            currentStep: 1,
            steps: { create: stepRows },
          },
          include: { steps: true },
        });
        await notifyApprovers(prisma, request, 1, 'Approval Required', `Deal "${deal.name}" submitted by ${req.user.firstName}`);

        await req.audit({ action: 'update', module: 'deals', recordId: deal.id, details: `Submitted deal for approval` });
        res.json({ success: true, approvalRequest: request });
      } catch (err) { next(err); }
    });

    // GET /api/deals/stats/rollup - Summary of all deal metrics
    router.get('/stats/rollup', requirePermission('deals', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);

        const [deals, ctx] = await Promise.all([
          prisma.deal.findMany({
            where: await visibleWhere(req, 'deals', 'deal'),
            select: { stage: true, value: true, currency: true, probability: true, closeDate: true, createdAt: true },
          }),
          currencyContext(prisma),
        ]);

        const open = deals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
        const won = deals.filter(d => d.stage === 'Closed Won');
        const lost = deals.filter(d => d.stage === 'Closed Lost');
        const newThisMonth = deals.filter(d => d.createdAt >= startOfMonth);
        const wonThisQuarter = won.filter(d => d.closeDate && d.closeDate >= startOfQuarter);

        res.json({
          currency: ctx.base,
          pipeline: { count: open.length, value: sumInBase(open, ctx), weighted: Math.round(open.reduce((s, d) => s + ctx.toBase(d.value, d.currency) * d.probability / 100, 0)) },
          won: { count: won.length, value: sumInBase(won, ctx) },
          lost: { count: lost.length, value: sumInBase(lost, ctx) },
          newThisMonth: { count: newThisMonth.length, value: sumInBase(newThisMonth, ctx) },
          wonThisQuarter: { count: wonThisQuarter.length, value: sumInBase(wonThisQuarter, ctx) },
          winRate: (won.length + lost.length) > 0 ? Math.round(won.length / (won.length + lost.length) * 100) : 0,
          avgDealSize: open.length > 0 ? Math.round(sumInBase(open, ctx) / open.length) : 0,
        });
      } catch (err) { next(err); }
    });
  },
});
