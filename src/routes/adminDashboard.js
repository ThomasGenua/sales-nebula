const fs = require('fs');
const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { currencyContext, sumInBase } = require('../utils/currency');
const { modelHasField } = require('../utils/modelFields');
const router = Router();
router.use(authenticate, requirePermission('admin', 'read'));

/** Routes the app answers, one per method and path, counted from its router. */
function countRoutes(stack = []) {
  return stack.reduce((n, layer) => n + (layer.route
    ? Object.keys(layer.route.methods).filter(m => m !== '_all').length
    : countRoutes(layer.handle?.stack)), 0);
}

router.get('/system', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Live records where a model soft-deletes; deleted ones were counted too.
    const live = model => prisma[model].count(modelHasField(model, 'deletedAt') ? { where: { deletedAt: null } } : undefined);

    // Model counts (all key tables)
    const [
      users, contacts, leads, deals, accounts, cases, activities,
      campaigns, products, quotes, invoices, contracts, orders,
      entitlements, workflows, reports, emailTemplates, knowledgeArticles,
      subscriptions, workOrders, customObjects, aiAgents, flowDefinitions,
      appListings, surveys, territories, assets, feedItems, portalConfigs,
    ] = await Promise.all([
      live('user'),
      live('contact'),
      live('lead'),
      live('deal'),
      live('account'),
      live('case'),
      live('activity'),
      live('campaign'),
      live('product'),
      live('quote'),
      live('invoice'),
      live('contract'),
      live('order'),
      live('entitlement'),
      live('workflow'),
      live('report'),
      live('emailTemplate'),
      live('knowledgeArticle'),
      live('subscription').catch(() => 0),
      live('workOrder').catch(() => 0),
      live('customObject').catch(() => 0),
      live('aiAgent').catch(() => 0),
      live('flowDefinition').catch(() => 0),
      live('appListing').catch(() => 0),
      live('survey').catch(() => 0),
      live('territory').catch(() => 0),
      live('asset').catch(() => 0),
      live('feedItem').catch(() => 0),
      live('portalConfig').catch(() => 0),
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

    // Counted, not typed in: these were fixed numbers (171 models, 574
    // endpoints, 253 indexes, 21426 lines) the admin page showed as the
    // platform's own. Indexes are the database's; null where it cannot say.
    const indexes = await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema()`
      .then(rows => rows[0]?.n ?? null).catch(() => null);

    res.json({
      platform: {
        models: Prisma.dmmf.datamodel.models.length,
        endpoints: countRoutes(req.app._router?.stack),
        indexes,
        routeFiles: fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).length,
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

