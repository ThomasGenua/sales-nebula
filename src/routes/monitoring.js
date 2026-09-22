const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { queryWithIncludes } = require('../utils/modelFields');

const router = Router();

// Login history with filtering
router.get('/login-history', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userId, status, limit = 100, page = 1 } = req.query;
    const where = {};
    if (userId) where.userId = userId;
    if (status) where.status = status;
    const [data, total] = await Promise.all([
      queryWithIncludes(prisma, 'loginHistory', 'findMany', { where, orderBy: { loginTime: 'desc' }, take: +limit, skip: (+page - 1) * +limit, include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
      prisma.loginHistory.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Event logs with search
router.get('/event-logs', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { eventType, module, userId, from, to, limit = 100, page = 1 } = req.query;
    const where = {};
    if (eventType) where.eventType = eventType;
    if (module) where.module = module;
    if (userId) where.userId = userId;
    if (from || to) {
      where.timestamp = {};
      if (from) where.timestamp.gte = new Date(from);
      if (to) where.timestamp.lte = new Date(to);
    }
    const [data, total] = await Promise.all([
      prisma.eventLog.findMany({ where, orderBy: { timestamp: 'desc' }, take: +limit, skip: (+page - 1) * +limit }),
      prisma.eventLog.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Real-time system metrics
router.get('/metrics', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const oneDayAgo = new Date(now - 86400000);
    const oneHourAgo = new Date(now - 3600000);

    const [totalUsers, activeToday, loginsToday, failedLogins, apiCalls, errorCount] = await Promise.all([
      prisma.user.count({ where: { active: true } }),
      prisma.loginHistory.findMany({ where: { loginTime: { gte: oneDayAgo }, status: 'Success' }, distinct: ['userId'] }).then(r => r.length),
      prisma.loginHistory.count({ where: { loginTime: { gte: oneDayAgo }, status: 'Success' } }),
      prisma.loginHistory.count({ where: { loginTime: { gte: oneDayAgo }, status: 'Failed' } }),
      prisma.eventLog.count({ where: { timestamp: { gte: oneHourAgo }, eventType: 'API_CALL' } }).catch(() => 0),
      prisma.eventLog.count({ where: { timestamp: { gte: oneHourAgo }, eventType: 'ERROR' } }).catch(() => 0),
    ]);
    res.json({
      system: { uptime: process.uptime(), memoryUsage: process.memoryUsage(), nodeVersion: process.version },
      users: { total: totalUsers, activeToday },
      auth: { loginsToday, failedLogins, failureRate: loginsToday ? ((failedLogins / (loginsToday + failedLogins)) * 100).toFixed(1) : 0 },
      api: { callsLastHour: apiCalls, errorsLastHour: errorCount },
    });
  } catch (err) { next(err); }
});

// Monitoring alerts
router.get('/alerts', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const alerts = [];
    const failedLogins = await prisma.loginHistory.count({ where: { loginTime: { gte: new Date(Date.now() - 3600000) }, status: 'Failed' } });
    if (failedLogins > 10) alerts.push({ severity: 'high', type: 'security', message: `${failedLogins} failed logins in the last hour`, timestamp: new Date() });
    const memUsage = process.memoryUsage();
    if (memUsage.heapUsed / memUsage.heapTotal > 0.85) alerts.push({ severity: 'warning', type: 'performance', message: 'Memory usage above 85%', timestamp: new Date() });
    res.json({ alerts, checkedAt: new Date() });
  } catch (err) { next(err); }
});

// Health deep-check
router.get('/health-deep', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const checks = {};
    try { await prisma.$queryRaw`SELECT 1`; checks.database = { status: 'healthy' }; } catch (e) { checks.database = { status: 'unhealthy', error: e.message }; }
    try { const c = req.app.locals.cache; if (c?.client) { await c.client.ping(); checks.redis = { status: 'healthy' }; } else { checks.redis = { status: 'not_configured' }; } } catch (e) { checks.redis = { status: 'unhealthy', error: e.message }; }
    checks.memory = { heapUsed: process.memoryUsage().heapUsed, heapTotal: process.memoryUsage().heapTotal, rss: process.memoryUsage().rss };
    checks.uptime = process.uptime();
    const allHealthy = checks.database.status === 'healthy' && (checks.redis.status !== 'unhealthy');
    res.status(allHealthy ? 200 : 503).json({ status: allHealthy ? 'healthy' : 'degraded', checks });
  } catch (err) { next(err); }
});

module.exports = router;

// Performance metrics over time
router.get('/metrics/performance', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { hours = 24 } = req.query;
    const since = new Date(Date.now() - (+hours) * 3600000);
    const [apiCalls, errors, avgResponse] = await Promise.all([
      prisma.eventLog.count({ where: { timestamp: { gte: since } } }).catch(() => 0),
      // EventLog has no level; a server error is what the status code says.
      prisma.eventLog.count({ where: { timestamp: { gte: since }, statusCode: { gte: 500 } } }).catch(() => 0),
      prisma.eventLog.aggregate({ where: { timestamp: { gte: since } }, _avg: { responseTime: true } }).catch(() => ({ _avg: { responseTime: null } })),
    ]);
    res.json({ period: `${hours}h`, apiCalls, errors, errorRate: apiCalls ? (errors / apiCalls * 100).toFixed(2) + '%' : '0%', avgResponseMs: Math.round(avgResponse._avg.responseTime || 0), uptime: process.uptime() });
  } catch (err) { next(err); }
});

// Alert rules CRUD
router.get('/alerts/rules', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.monitoringAlertRule.findMany({ orderBy: { createdAt: 'desc' } }).catch(() => []);
    res.json(rules);
  } catch (err) { next(err); }
});

router.post('/alerts/rules', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, metric, condition, threshold, channel, action, enabled } = req.body;
    // metric and threshold are required columns: a rule that watches nothing
    // against no limit cannot fire.
    if (!name || !metric || !condition || threshold == null || !Number.isFinite(Number(threshold))) {
      return res.status(400).json({ error: 'name, metric, condition and a numeric threshold are required' });
    }
    const rule = await prisma.monitoringAlertRule.create({ data: { name, metric, condition, threshold: Number(threshold), channel: channel || null, action: action || 'notify', active: enabled !== false, createdById: req.user.id } });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// Storage metrics
router.get('/metrics/storage', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [attachments, documents] = await Promise.all([
      prisma.attachment.aggregate({ _sum: { fileSize: true }, _count: true }),
      prisma.document.aggregate({ _sum: { fileSize: true }, _count: true }).catch(() => ({ _sum: { fileSize: 0 }, _count: 0 })),
    ]);
    const totalBytes = (attachments._sum.fileSize || 0) + (documents._sum?.fileSize || 0);
    res.json({ totalFiles: (attachments._count || 0) + (documents._count || 0), totalSizeBytes: totalBytes, totalSizeMB: Math.round(totalBytes / 1048576), attachments: { count: attachments._count, sizeBytes: attachments._sum.fileSize || 0 }, documents: { count: documents._count || 0, sizeBytes: documents._sum?.fileSize || 0 } });
  } catch (err) { next(err); }
});

// Performance trends (last 24h by hour)
router.get('/trends', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const hours = [];
    for (let i = 23; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 3600000);
      const end = new Date(Date.now() - i * 3600000);
      const [logins, events] = await Promise.all([
        prisma.loginHistory.count({ where: { loginTime: { gte: start, lt: end } } }).catch(() => 0),
        prisma.eventLog.count({ where: { timestamp: { gte: start, lt: end } } }).catch(() => 0),
      ]);
      hours.push({ hour: start.toISOString().substring(11, 16), logins, events });
    }
    res.json({ period: '24h', dataPoints: hours });
  } catch (err) { next(err); }
});
