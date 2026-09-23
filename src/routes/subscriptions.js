const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { createCrudRouter } = require('../utils/crud');
const { SUBSCRIPTION_NUMBER } = require('../utils/numbering');

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
});

// Renew subscription
router.post('/:id/renew', authenticate, requirePermission('subscriptions', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sub = await prisma.subscription.findUnique({ where: { id: req.params.id } });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    const { term, priceAdjustment } = req.body;
    const newStart = sub.endDate ? new Date(sub.endDate) : new Date();
    const newEnd = new Date(newStart);
    newEnd.setMonth(newEnd.getMonth() + (term || sub.term || 12));
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
    const sub = await prisma.subscription.findUnique({ where: { id: req.params.id } });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
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
    const [total, active, cancelled, expiringSoon] = await Promise.all([
      prisma.subscription.count({ where: { deletedAt: null } }),
      prisma.subscription.count({ where: { status: 'Active', deletedAt: null } }),
      prisma.subscription.count({ where: { status: 'Cancelled', deletedAt: null } }),
      prisma.subscription.count({ where: { status: 'Active', endDate: { lte: new Date(Date.now() + 30 * 86400000) }, deletedAt: null } }),
    ]);
    const activeSubs = await prisma.subscription.findMany({ where: { status: 'Active', deletedAt: null } });
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
    const sub = await prisma.subscription.findUnique({ where: { id: req.params.id } });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const daysLeft = sub.endDate ? Math.floor((new Date(sub.endDate) - Date.now()) / 86400000) : null;
    const issues = [];
    if (daysLeft !== null && daysLeft < 30) issues.push('Expiring soon');
    if (sub.paymentStatus === 'overdue') issues.push('Payment overdue');
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
    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: req.params.id, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    res.json(invoices);
  } catch (err) { next(err); }
});

// Churn prediction
router.get('/analytics/churn-risk', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const subs = await prisma.subscription.findMany({ where: { status: 'Active', deletedAt: null }, include: { account: { select: { name: true } } } });
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
    const subs = await prisma.subscription.findMany({ where: { deletedAt: null }, select: { status: true, startDate: true, endDate: true, totalPrice: true, createdAt: true } });
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
