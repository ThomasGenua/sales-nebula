const { Router } = require('express');
const { authenticate } = require('../middleware/auth');

const router = Router();

// Mobile config
router.get('/config', authenticate, async (req, res, next) => {
  res.json({
    version: '1.0.0', minVersion: '1.0.0',
    features: { offlineSync: true, pushNotifications: true, biometricAuth: true, darkMode: true },
    syncModules: ['contacts', 'leads', 'deals', 'accounts', 'activities', 'cases'],
    refreshInterval: 300,
  });
});

// Register device for push notifications
router.post('/devices', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { token, platform, deviceName } = req.body;
    if (!token || !platform) return res.status(400).json({ error: 'token and platform required' });
    const device = await prisma.mobileDevice.upsert({
      where: { pushToken: token },
      update: { platform, deviceName, lastActiveAt: new Date(), userId: req.user.id },
      create: { pushToken: token, platform, deviceName, userId: req.user.id },
    });
    res.json(device);
  } catch (err) { next(err); }
});

// Push notification
router.post('/push', authenticate, async (req, res, next) => {
  try {
    const { userId, title, body, data } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    // Queue notification (would integrate with FCM/APNS in production)
    res.json({ queued: true, title, body, targetUser: userId || 'broadcast' });
  } catch (err) { next(err); }
});

// Mobile notifications feed
router.get('/notifications', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    res.json({ data: notifications, unread: notifications.filter(n => !n.readAt).length });
  } catch (err) { next(err); }
});

// Mobile activity feed (compact format)
router.get('/feed', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { limit = 20, before } = req.query;
    const where = { OR: [{ ownerId: req.user.id }, { assignedToId: req.user.id }] };
    if (before) where.createdAt = { lt: new Date(before) };
    const activities = await prisma.activity.findMany({
      where, orderBy: { createdAt: 'desc' }, take: +limit,
      select: { id: true, type: true, subject: true, status: true, createdAt: true, dueDate: true },
    });
    res.json({ data: activities });
  } catch (err) { next(err); }
});

// Sync endpoint (bulk data for offline)
router.get('/sync', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { since, modules } = req.query;
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 86400000);
    const syncModules = modules ? modules.split(',') : ['contacts', 'leads', 'deals', 'activities'];
    const data = {};
    const modelMap = { contacts: 'contact', leads: 'lead', deals: 'deal', activities: 'activity', accounts: 'account', cases: 'case' };
    for (const mod of syncModules) {
      const model = modelMap[mod];
      if (!model) continue;
      try {
        data[mod] = await prisma[model].findMany({
          where: { updatedAt: { gte: sinceDate }, deletedAt: null },
          take: 500, orderBy: { updatedAt: 'desc' },
        });
      } catch (e) { data[mod] = []; }
    }
    res.json({ syncedAt: new Date(), since: sinceDate, data });
  } catch (err) { next(err); }
});

// Offline sync push (upload changes made offline)
router.post('/sync', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { changes } = req.body;
    if (!changes?.length) return res.json({ processed: 0 });
    const results = [];
    for (const change of changes) {
      try {
        const model = change.module === 'cases' ? 'case' : change.module;
        if (change.action === 'create') {
          const record = await prisma[model].create({ data: change.data });
          results.push({ id: change.localId, serverId: record.id, status: 'created' });
        } else if (change.action === 'update') {
          await prisma[model].update({ where: { id: change.id }, data: change.data });
          results.push({ id: change.id, status: 'updated' });
        }
      } catch (e) { results.push({ id: change.id || change.localId, status: 'error', error: e.message }); }
    }
    res.json({ processed: results.length, results });
  } catch (err) { next(err); }
});

module.exports = router;

// Mobile dashboard (compact)
router.get('/dashboard', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const userId = req.user.id;
    const today = new Date(); today.setHours(0,0,0,0);
    const [myDeals, myTasks, myCases, overdue] = await Promise.all([
      prisma.deal.count({ where: { ownerId: userId, stage: { notIn: ['Closed Won','Closed Lost'] }, deletedAt: null } }),
      prisma.activity.count({ where: { ownerId: userId, status: { not: 'Completed' }, dueDate: { lte: new Date(today.getTime() + 86400000) }, deletedAt: null } }),
      prisma.case.count({ where: { ownerId: userId, status: { notIn: ['Closed','Resolved'] }, deletedAt: null } }),
      prisma.activity.count({ where: { ownerId: userId, status: { not: 'Completed' }, dueDate: { lt: today }, deletedAt: null } }),
    ]);
    res.json({ myOpenDeals: myDeals, myTasksToday: myTasks, myOpenCases: myCases, overdueTasks: overdue });
  } catch (err) { next(err); }
});

// Quick log (call/meeting from mobile)
router.post('/quick-log', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { type, subject, contactId, dealId, duration, notes } = req.body;
    if (!type || !subject) return res.status(400).json({ error: 'type and subject required' });
    const activity = await prisma.activity.create({
      data: { type, subject, description: notes, duration: +duration || null, status: 'Completed', ownerId: req.user.id, ...(contactId && { contactId }), ...(dealId && { dealId }) },
    });
    res.status(201).json(activity);
  } catch (err) { next(err); }
});

// Device management (list all devices for user)
router.get('/devices', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const devices = await prisma.mobileDevice.findMany({ where: { userId: req.user.id }, orderBy: { lastActiveAt: 'desc' } });
    res.json(devices);
  } catch (err) { next(err); }
});

// Remove device
router.delete('/devices/:deviceId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.mobileDevice.deleteMany({ where: { id: req.params.deviceId, userId: req.user.id } });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

// Push notification preferences
router.get('/push-preferences', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const prefs = await prisma.pushPreference.findFirst({ where: { userId: req.user.id } }).catch(() => null);
    res.json(prefs || { deals: true, cases: true, mentions: true, approvals: true, tasks: true, quietHoursStart: null, quietHoursEnd: null });
  } catch (err) { next(err); }
});

router.put('/push-preferences', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.pushPreference.findFirst({ where: { userId: req.user.id } }).catch(() => null);
    const prefs = existing
      ? await prisma.pushPreference.update({ where: { id: existing.id }, data: req.body })
      : await prisma.pushPreference.create({ data: { ...req.body, userId: req.user.id } });
    res.json(prefs);
  } catch (err) { next(err); }
});

// Offline conflict resolution
router.post('/sync/resolve', authenticate, async (req, res, next) => {
  try {
    const { conflicts } = req.body;
    if (!conflicts?.length) return res.status(400).json({ error: 'conflicts array required' });
    const resolved = conflicts.map(c => ({ ...c, resolution: c.strategy === 'client_wins' ? 'client' : c.strategy === 'server_wins' ? 'server' : 'latest_timestamp', resolvedAt: new Date() }));
    res.json({ resolved: resolved.length, conflicts: resolved });
  } catch (err) { next(err); }
});
