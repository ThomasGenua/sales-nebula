const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── USERS ───

router.get('/', requirePermission('users', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const users = await prisma.user.findMany({
      include: { role: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: users.map(({ password, ...u }) => u) });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('users', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { role: { include: { permissions: true } } },
    });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { password, ...safeUser } = user;

    // Get recent audit logs for this user
    const recentActivity = await prisma.auditLog.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    res.json({ ...safeUser, recentActivity });
  } catch (err) { next(err); }
});

router.post('/', requirePermission('users', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, password, firstName, lastName, roleId, active } = req.body;
    if (!email || !password || !firstName) return res.status(400).json({ error: 'Missing required fields' });

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hash, firstName, lastName, roleId, active: active !== false },
      include: { role: true },
    });
    await req.audit({ action: 'create', module: 'users', recordId: user.id, details: `Created user ${email}` });
    const { password: _, ...safeUser } = user;
    res.status(201).json(safeUser);
  } catch (err) { next(err); }
});

router.put('/:id', requirePermission('users', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { password, id, createdAt, updatedAt, role, recentActivity, ...data } = req.body;
    if (password) data.password = await bcrypt.hash(password, 10);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      include: { role: true },
    });
    await req.audit({ action: 'update', module: 'users', recordId: user.id });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('users', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (req.params.id === req.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── ROLES ───

router.get('/roles/all', requirePermission('roles', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const roles = await prisma.role.findMany({
      include: { permissions: true, _count: { select: { users: true } } },
    });
    res.json({ data: roles });
  } catch (err) { next(err); }
});

router.post('/roles', requirePermission('roles', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, permissions } = req.body;
    const role = await prisma.role.create({
      data: {
        name,
        description,
        permissions: { create: permissions || [] },
      },
      include: { permissions: true },
    });
    res.status(201).json(role);
  } catch (err) { next(err); }
});

router.put('/roles/:id', requirePermission('roles', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, permissions } = req.body;

    // Update role and recreate permissions
    if (permissions) {
      await prisma.permission.deleteMany({ where: { roleId: req.params.id } });
    }

    const role = await prisma.role.update({
      where: { id: req.params.id },
      data: {
        name,
        description,
        ...(permissions && { permissions: { create: permissions.map(p => ({ module: p.module, level: p.level })) } }),
      },
      include: { permissions: true },
    });
    res.json(role);
  } catch (err) { next(err); }
});

router.delete('/roles/:id', requirePermission('roles', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const usersWithRole = await prisma.user.count({ where: { roleId: req.params.id } });
    if (usersWithRole > 0) return res.status(400).json({ error: 'Cannot delete role with assigned users' });
    await prisma.role.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/users/me/preferences
// GET /api/users/online - Active users (based on recent activity)
router.get('/online', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Consider users "online" if they created an audit log entry in last 15 minutes
    const threshold = new Date(Date.now() - 15 * 60 * 1000);
    const recentLogs = await prisma.auditLog.findMany({
      where: { timestamp: { gte: threshold } },
      select: { userId: true },
      distinct: ['userId'],
    });
    const onlineIds = recentLogs.map(l => l.userId).filter(Boolean);
    const users = await prisma.user.findMany({
      where: { id: { in: onlineIds }, active: true },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    res.json({ data: users, count: users.length });
  } catch (err) { next(err); }
});

// GET /api/users/me/preferences
router.get('/me/preferences', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const config = await prisma.adminConfig.findUnique({ where: { key: `user_prefs:${req.userId}` } });
    const defaults = {
      theme: 'light',
      dashboardLayout: 'default',
      emailNotifications: true,
      desktopNotifications: false,
      timezone: 'America/New_York',
      dateFormat: 'MM/DD/YYYY',
      pageSize: 50,
      defaultModule: 'deals',
    };
    const prefs = config ? { ...defaults, ...JSON.parse(config.value) } : defaults;
    res.json(prefs);
  } catch (err) { next(err); }
});

// PUT /api/users/me/preferences
router.put('/me/preferences', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const key = `user_prefs:${req.userId}`;
    const existing = await prisma.adminConfig.findUnique({ where: { key } });
    const current = existing ? JSON.parse(existing.value) : {};
    const merged = { ...current, ...req.body };

    await prisma.adminConfig.upsert({
      where: { key },
      create: { key, value: JSON.stringify(merged) },
      update: { value: JSON.stringify(merged) },
    });

    res.json(merged);
  } catch (err) { next(err); }
});

// GET /api/users/me/activity - Recent activity for logged-in user
router.get('/me/activity', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [myDeals, myActivities, myLeads, myNotifications] = await Promise.all([
      prisma.deal.findMany({
        where: { ownerId: req.userId, stage: { notIn: ['Closed Won', 'Closed Lost'] } },
        orderBy: { updatedAt: 'desc' }, take: 10,
        select: { id: true, name: true, stage: true, value: true, closeDate: true, account: { select: { name: true } } },
      }),
      prisma.activity.findMany({
        where: { assignedId: req.userId, status: { not: 'Completed' } },
        orderBy: { date: 'asc' }, take: 10,
      }),
      prisma.lead.findMany({
        where: { assignedId: req.userId, status: { notIn: ['Converted', 'Unqualified'] } },
        orderBy: { updatedAt: 'desc' }, take: 10,
        select: { id: true, firstName: true, lastName: true, company: true, status: true, score: true },
      }),
      prisma.notification.findMany({
        where: { userId: req.userId, read: false },
        orderBy: { createdAt: 'desc' }, take: 20,
      }),
    ]);

    // Overdue activities
    const now = new Date();
    const overdueActivities = myActivities.filter(a => a.date < now);

    res.json({
      deals: myDeals,
      upcomingActivities: myActivities,
      overdueActivities,
      leads: myLeads,
      unreadNotifications: myNotifications,
    });
  } catch (err) { next(err); }
});

module.exports = router;
