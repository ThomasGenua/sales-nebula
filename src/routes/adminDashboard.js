const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { currencyContext, sumInBase } = require('../utils/currency');
const router = Router();
router.use(authenticate, requirePermission('admin', 'read'));

router.get('/system', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;

    // Model counts (all key tables)
    const [
      users, contacts, leads, deals, accounts, cases, activities,
      campaigns, products, quotes, invoices, contracts, orders,
      entitlements, workflows, reports, emailTemplates, knowledgeArticles,
      subscriptions, workOrders, customObjects, aiAgents, flowDefinitions,
      appListings, surveys, territories, assets, feedItems, portalConfigs,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.contact.count(),
      prisma.lead.count(),
      prisma.deal.count(),
      prisma.account.count(),
      prisma.case.count(),
      prisma.activity.count(),
      prisma.campaign.count(),
      prisma.product.count(),
      prisma.quote.count(),
      prisma.invoice.count(),
      prisma.contract.count(),
      prisma.order.count(),
      prisma.entitlement.count(),
      prisma.workflow.count(),
      prisma.report.count(),
      prisma.emailTemplate.count(),
      prisma.knowledgeArticle.count(),
      prisma.subscription.count().catch(() => 0),
      prisma.workOrder.count().catch(() => 0),
      prisma.customObject.count().catch(() => 0),
      prisma.aiAgent.count().catch(() => 0),
      prisma.flowDefinition.count().catch(() => 0),
      prisma.appListing.count().catch(() => 0),
      prisma.survey.count().catch(() => 0),
      prisma.territory.count().catch(() => 0),
      prisma.asset.count().catch(() => 0),
      prisma.feedItem.count().catch(() => 0),
      prisma.portalConfig.count().catch(() => 0),
    ]);

    // Security stats
    const [
      ssoConfigs, mfaDevices, encryptionPolicies, apiKeys,
      loginHistory24h, eventLogs24h, duplicateRecords,
    ] = await Promise.all([
      prisma.ssoConfig.count().catch(() => 0),
      prisma.mfaDevice.count({ where: { verified: true } }).catch(() => 0),
      prisma.encryptionPolicy.count({ where: { active: true } }).catch(() => 0),
      prisma.apiKey.count({ where: { active: true } }).catch(() => 0),
      prisma.loginHistory.count({ where: { loginTime: { gte: new Date(Date.now() - 86400000) } } }).catch(() => 0),
      prisma.eventLog.count({ where: { timestamp: { gte: new Date(Date.now() - 86400000) } } }).catch(() => 0),
      prisma.duplicateRecord.count({ where: { status: 'Active' } }).catch(() => 0),
    ]);

    // Pipeline stats
    // In the default currency, over live deals.
    const deals_data = await prisma.deal.findMany({
      select: { value: true, currency: true, stage: true },
      where: { stage: { notIn: ['Closed Lost'] }, deletedAt: null },
    });
    const ctx = await currencyContext(prisma);
    const pipelineValue = sumInBase(deals_data, ctx);
    const wonDeals = deals_data.filter(d => d.stage === 'Closed Won');
    const wonValue = sumInBase(wonDeals, ctx);

    // Automation stats
    const [activeWorkflows, activeFlows, approvalsPending] = await Promise.all([
      prisma.workflow.count({ where: { active: true } }),
      prisma.flowDefinition.count({ where: { status: 'Active' } }).catch(() => 0),
      prisma.approvalRequest.count({ where: { status: 'Pending' } }).catch(() => 0),
    ]);

    // Storage estimate (rough)
    const totalRecords = users + contacts + leads + deals + accounts + cases + activities +
      campaigns + products + quotes + invoices + contracts + orders + subscriptions + workOrders;

    res.json({
      platform: {
        models: 171,
        endpoints: 574,
        indexes: 253,
        routeFiles: 85,
        totalCodeLines: 21426,
      },
      records: {
        users, contacts, leads, deals, accounts, cases, activities,
        campaigns, products, quotes, invoices, contracts, orders,
        entitlements, workflows, reports, emailTemplates, knowledgeArticles,
        subscriptions, workOrders, customObjects, aiAgents, flowDefinitions,
        appListings, surveys, territories, assets, feedItems, portalConfigs,
        total: totalRecords,
      },
      security: {
        ssoProviders: ssoConfigs,
        mfaDevicesEnrolled: mfaDevices,
        encryptionPolicies,
        activeApiKeys: apiKeys,
        loginsLast24h: loginHistory24h,
        eventsLast24h: eventLogs24h,
        activeDuplicates: duplicateRecords,
      },
      revenue: {
        pipelineValue,
        wonValue,
        openDeals: deals_data.length - wonDeals.length,
        wonDeals: wonDeals.length,
      },
      automation: {
        activeWorkflows,
        activeFlows,
        approvalsPending,
      },
      health: {
        database: 'connected',
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version,
        timestamp: new Date(),
      },
    });
  } catch (err) { next(err); }
});

// Recent activity feed for admins
router.get('/activity', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const since = new Date(Date.now() - 7 * 86400000);
    const [recentLogins, recentAudit, recentFlowRuns, recentAgentRuns] = await Promise.all([
      prisma.loginHistory.findMany({ where: { loginTime: { gte: since } }, orderBy: { loginTime: 'desc' }, take: 10 }).catch(() => []),
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }).catch(() => []),
      prisma.flowRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10, include: { flow: { select: { name: true } } } }).catch(() => []),
      prisma.aiAgentRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10, include: { agent: { select: { name: true, type: true } } } }).catch(() => []),
    ]);
    res.json({ recentLogins, recentAudit, recentFlowRuns, recentAgentRuns });
  } catch (err) { next(err); }
});

module.exports = router;

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'AdminDashboard';
    // Generic stats endpoint
    const stats = {
      module: 'adminDashboard',
      generatedAt: new Date(),
      environment: process.env.NODE_ENV || 'development',
    };
    res.json(stats);
  } catch (err) { next(err); }
});

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "adminDashboard" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'adminDashboard', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
