const crypto = require('crypto');
const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { editableFields, modelHasField, columnsFrom } = require('../utils/modelFields');

const router = Router();

// The modules offline sync carries, and the table each lives in.
const SYNC_MODELS = { contacts: 'contact', leads: 'lead', deals: 'deal', activities: 'activity', accounts: 'account', cases: 'case' };

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
    // deviceId is the unique key and is required; pushToken is neither, so the
    // upsert could not run. A client that sends no deviceId is identified by
    // its push token.
    const deviceId = req.body.deviceId || crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
    const device = await prisma.mobileDevice.upsert({
      where: { deviceId },
      update: { pushToken: token, platform, deviceName, lastActiveAt: new Date(), userId: req.user.id },
      create: { deviceId, pushToken: token, platform, deviceName, userId: req.user.id },
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

// Mobile notifications feed. `limit` was ignored (always 50), and unread
// counted every row: the column is `read`, not `readAt`. `body` is the
// message, which the bell shows under the title.
router.get('/notifications', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const [notifications, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take }),
      prisma.notification.count({ where: { userId: req.user.id, read: false } }),
    ]);
    res.json({ data: notifications.map(n => ({ ...n, body: n.message })), unread });
  } catch (err) { next(err); }
});

// Mobile activity feed (compact format)
router.get('/feed', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { limit = 20, before } = req.query;
    // The column is assignedId; assignedToId failed every request. Deleted
    // activities stay out.
    const where = { OR: [{ ownerId: req.user.id }, { assignedId: req.user.id }], deletedAt: null };
    if (before) where.createdAt = { lt: new Date(before) };
    const activities = await prisma.activity.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Math.min(parseInt(limit, 10) || 20, 200),
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
    const syncModules = modules ? String(modules).split(',') : ['contacts', 'leads', 'deals', 'activities'];
    const data = {};
    // Modules the caller may read, and their rows only: this sent every
    // user's recent records to anyone signed in.
    for (const mod of syncModules) {
      const model = SYNC_MODELS[mod];
      if (!model || !permits(req, mod, 'read')) continue;
      try {
        data[mod] = await prisma[model].findMany({
          where: await reachableWhere(req, mod, model, { updatedAt: { gte: sinceDate } }),
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
    const { changes } = req.body || {};
    if (!Array.isArray(changes) || !changes.length) return res.json({ processed: 0 });
    const results = [];
    // `module` named the Prisma model itself, so a change to "user" or
    // "permission" rewrote accounts and roles: anyone signed in could make
    // themselves an administrator. A change is now one of the sync modules,
    // takes edit permission on it, writes the model's own columns, and
    // updates only records the caller may change. Links (a deal's account)
    // must name records the caller can see.
    const seen = new Map();
    for (const change of changes.slice(0, 500)) {
      try {
        const model = SYNC_MODELS[change?.module];
        if (!model) throw new Error(`Cannot sync ${change?.module}`);
        if (!permits(req, change.module, 'edit')) throw new Error(`Insufficient permissions for ${change.module}`);
        const data = editableFields(model, change.data);
        if (change.action === 'create') {
          if (modelHasField(model, 'ownerId')) data.ownerId = req.userId;
          const refusal = await linkRefusal(req, model, data, null, seen);
          if (refusal) throw new Error(refusal);
          const record = await prisma[model].create({ data });
          results.push({ id: change.localId, serverId: record.id, status: 'created' });
        } else if (change.action === 'update') {
          const current = await prisma[model].findFirst({
            where: await reachableWhere(req, change.module, model, { id: String(change.id) }, 'Edit'),
          });
          if (!current) throw new Error('Not found');
          const refusal = await linkRefusal(req, model, data, current, seen);
          if (refusal) throw new Error(refusal);
          await prisma[model].update({ where: { id: current.id }, data });
          results.push({ id: change.id, status: 'updated' });
        }
      } catch (e) { results.push({ id: change?.id || change?.localId, status: 'error', error: e.message }); }
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
    // As a synced create: activities edit, and only on a contact or deal the
    // caller can see. This logged against any id, with no permission at all.
    if (!permits(req, 'activities', 'edit')) return res.status(403).json({ error: 'Insufficient permissions for activities' });
    const refusal = await linkRefusal(req, 'activity', { contactId, dealId });
    if (refusal) return res.status(400).json({ error: refusal, code: 'LINK_NOT_VISIBLE' });
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
    // By the device's own id, which is what the app knows, or the row id.
    const { count } = await prisma.mobileDevice.deleteMany({
      where: { userId: req.user.id, OR: [{ id: req.params.deviceId }, { deviceId: req.params.deviceId }] },
    });
    res.json({ removed: count > 0 });
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
    // The preference row's own columns, and always the caller's.
    const { userId, ...data } = columnsFrom('pushPreference', req.body);
    const prefs = existing
      ? await prisma.pushPreference.update({ where: { id: existing.id }, data })
      : await prisma.pushPreference.create({ data: { ...data, userId: req.user.id } });
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
