const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { SUBSCRIPTION_NUMBER } = require('../utils/numbering');

/**
 * `data` with its totalPrice worked out as unit price times quantity, unless
 * the caller set a total of their own. The column is required and the
 * subscription page sends no total, so a create from it answered 500; and an
 * edit to the price (the page sends the old total back) kept the old total.
 */
function withTotalPrice(data, current = null) {
  const sent = key => data[key] !== undefined && data[key] !== '';
  const changed = key => sent(key) && (!current || String(data[key]) !== String(current[key]));
  if (changed('totalPrice')) return data;
  if (current && !changed('unitPrice') && !changed('quantity')) return data;
  const unitPrice = Number(sent('unitPrice') ? data.unitPrice : current?.unitPrice) || 0;
  const quantity = Number(sent('quantity') ? data.quantity : current?.quantity) || 1;
  return { ...data, totalPrice: unitPrice * quantity };
}

const router = createCrudRouter('subscription', 'subscriptions', {
  include: {
    account: { select: { id: true, name: true } },
    product: { select: { id: true, name: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { subscriptionNumber: { contains: q, mode: 'insensitive' } },
      { account: { name: { contains: q, mode: 'insensitive' } } },
    ],
  }),
  numbering: SUBSCRIPTION_NUMBER,
  // A subscription must have an account, its dates and a price; without them
  // the create answered 500.
  validate: (data) => {
    const errors = {};
    for (const field of ['accountId', 'startDate', 'endDate']) if (!data[field]) errors[field] = 'Required';
    if (data.unitPrice === undefined || data.unitPrice === '' || !Number.isFinite(Number(data.unitPrice))) errors.unitPrice = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  beforeCreate: (data) => withTotalPrice(data),
  beforeUpdate: async (data, req) => {
    if (data.unitPrice === undefined && data.quantity === undefined) return data;
    const current = await req.app.locals.prisma.subscription.findUnique({ where: { id: req.params.id }, select: { unitPrice: true, quantity: true, totalPrice: true } });
    return current ? withTotalPrice(data, current) : data;
  },
});

// Renew subscription
router.post('/:id/renew', authenticate, requirePermission('subscriptions', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sub = await prisma.subscription.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    const { priceAdjustment } = req.body;
    // A number of months: sent as text it was appended to the month.
    const term = parseInt(req.body.term) || sub.term || 12;
    const newStart = sub.endDate ? new Date(sub.endDate) : new Date();
    const newEnd = new Date(newStart);
    newEnd.setMonth(newEnd.getMonth() + term);
    const renewed = await prisma.subscription.update({
      where: { id: req.params.id },
      data: {
        startDate: newStart, endDate: newEnd, status: 'Active',
        renewalCount: (sub.renewalCount || 0) + 1,
        ...(priceAdjustment && { unitPrice: priceAdjustment }),
        totalPrice: (priceAdjustment || parseFloat(sub.unitPrice) || 0) * (sub.quantity || 1),
      },
    });
    await req.audit({ action: 'update', module: 'subscriptions', recordId: sub.id, details: `Renewed until ${newEnd.toISOString().split('T')[0]}` });
    res.json(renewed);
  } catch (err) { next(err); }
});

// Cancel subscription
router.post('/:id/cancel', authenticate, requirePermission('subscriptions', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { reason, cancelDate, prorated } = req.body;
    const sub = await prisma.subscription.update({
      where: { id: req.params.id },
      data: { status: 'Cancelled', cancellationReason: reason, cancellationDate: cancelDate ? new Date(cancelDate) : new Date() },
    });
    await req.audit({ action: 'update', module: 'subscriptions', recordId: sub.id, details: `Cancelled: ${reason || 'No reason'}` });
    res.json(sub);
  } catch (err) { next(err); }
});

// Upgrade/downgrade
router.post('/:id/change-plan', authenticate, requirePermission('subscriptions', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { productId, unitPrice, quantity, effective } = req.body;
    if (!productId && !unitPrice) return res.status(400).json({ error: 'productId or unitPrice required' });
    const sub = await prisma.subscription.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    // A live product the caller can see; the id was stored as sent.
    const linkProblem = await linkRefusal(req, 'subscription', { productId }, sub);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const updated = await prisma.subscription.update({
      where: { id: req.params.id },
      data: {
        ...(productId && { productId }),
        ...(unitPrice && { unitPrice }),
        ...(quantity && { quantity }),
        totalPrice: (unitPrice || parseFloat(sub.unitPrice) || 0) * (quantity || sub.quantity || 1),
        changeEffectiveDate: effective ? new Date(effective) : new Date(),
      },
    });
    await req.audit({ action: 'update', module: 'subscriptions', recordId: sub.id, details: 'Plan changed' });
    res.json(updated);
  } catch (err) { next(err); }
});

// Subscription metrics
router.get('/stats/overview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Over the live subscriptions the caller may see; this counted everyone's.
    const visible = where => reachableWhere(req, 'subscriptions', 'subscription', where);
    const [total, active, cancelled, expiringSoon] = await Promise.all([
      prisma.subscription.count({ where: await visible() }),
      prisma.subscription.count({ where: await visible({ status: 'Active' }) }),
      prisma.subscription.count({ where: await visible({ status: 'Cancelled' }) }),
      prisma.subscription.count({ where: await visible({ status: 'Active', endDate: { lte: new Date(Date.now() + 30 * 86400000) } }) }),
    ]);
    const activeSubs = await prisma.subscription.findMany({ where: await visible({ status: 'Active' }) });
    const mrr = activeSubs.reduce((s, sub) => {
      const monthly = sub.billingFrequency === 'Monthly' ? parseFloat(sub.totalPrice) || 0
        : sub.billingFrequency === 'Quarterly' ? (parseFloat(sub.totalPrice) || 0) / 3
        : (parseFloat(sub.totalPrice) || 0) / 12;
      return s + monthly;
    }, 0);
    res.json({ total, active, cancelled, expiringSoon, churnRate: total ? ((cancelled / total) * 100).toFixed(1) : 0, mrr: mrr.toFixed(2), arr: (mrr * 12).toFixed(2) });
  } catch (err) { next(err); }
});

module.exports = router;

// Subscription health
router.get('/:id/health', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sub = await prisma.subscription.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const daysLeft = sub.endDate ? Math.floor((new Date(sub.endDate) - Date.now()) / 86400000) : null;
    const issues = [];
    if (daysLeft !== null && daysLeft < 30) issues.push('Expiring soon');
    // A subscription has no paymentStatus, so this never fired: payment is
    // overdue when one of its invoices (that the caller may see) is.
    const overdueInvoices = permits(req, 'invoices', 'read')
      ? await prisma.invoice.count({ where: await reachableWhere(req, 'invoices', 'invoice', { subscriptionId: sub.id, OR: [{ status: 'Overdue' }, { status: 'Sent', dueDate: { lt: new Date() } }] }) })
      : 0;
    if (overdueInvoices) issues.push('Payment overdue');
    if (sub.status === 'Cancelled') issues.push('Cancelled');
    res.json({ subscriptionId: sub.id, status: sub.status, daysRemaining: daysLeft, health: issues.length === 0 ? 'healthy' : issues.length < 2 ? 'warning' : 'critical', issues });
  } catch (err) { next(err); }
});

// Usage tracking
router.get('/:id/usage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const usage = await prisma.subscriptionUsage.findMany({ where: { subscriptionId: req.params.id }, orderBy: { period: 'desc' }, take: 12 }).catch(() => []);
    res.json(usage);
  } catch (err) { next(err); }
});

// Invoice history
router.get('/:id/invoices', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Invoices only with their read permission, and only those row security
    // lets the caller see, as an account's timeline lists them.
    const invoices = permits(req, 'invoices', 'read')
      ? await prisma.invoice.findMany({ where: await reachableWhere(req, 'invoices', 'invoice', { subscriptionId: req.params.id }), orderBy: { createdAt: 'desc' } })
      : [];
    res.json(invoices);
  } catch (err) { next(err); }
});

// Churn prediction
router.get('/analytics/churn-risk', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The subscriptions the caller may see; this listed everyone's.
    const subs = await prisma.subscription.findMany({ where: await reachableWhere(req, 'subscriptions', 'subscription', { status: 'Active' }), include: { account: { select: { name: true } } } });
    const atRisk = subs.filter(s => {
      const daysToEnd = s.endDate ? (new Date(s.endDate) - Date.now()) / 86400000 : 999;
      return daysToEnd < 30 && !s.autoRenew;
    }).map(s => ({ id: s.id, account: s.account?.name, endDate: s.endDate, daysRemaining: Math.floor((new Date(s.endDate) - Date.now()) / 86400000), autoRenew: s.autoRenew, value: s.totalPrice }));
    atRisk.sort((a, b) => a.daysRemaining - b.daysRemaining);
    res.json({ atRiskCount: atRisk.length, totalAtRiskRevenue: atRisk.reduce((s, r) => s + (r.value || 0), 0), subscriptions: atRisk });
  } catch (err) { next(err); }
});

// Cohort analysis
router.get('/analytics/cohorts', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const subs = await prisma.subscription.findMany({ where: await reachableWhere(req, 'subscriptions', 'subscription'), select: { status: true, startDate: true, endDate: true, totalPrice: true, createdAt: true } });
    const cohorts = {};
    subs.forEach(s => {
      const month = new Date(s.startDate || s.createdAt).toISOString().substring(0, 7);
      if (!cohorts[month]) cohorts[month] = { started: 0, active: 0, cancelled: 0, revenue: 0 };
      cohorts[month].started++;
      if (s.status === 'Active') cohorts[month].active++;
      if (s.status === 'Cancelled') cohorts[month].cancelled++;
      cohorts[month].revenue += s.totalPrice || 0;
    });
    res.json({ cohorts: Object.entries(cohorts).map(([month, data]) => ({ month, ...data, retentionRate: data.started > 0 ? ((data.active / data.started) * 100).toFixed(1) + '%' : '0%' })) });
  } catch (err) { next(err); }
});

module.exports = router;
