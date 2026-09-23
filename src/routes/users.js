const { Router } = require('express');
const bcrypt = require('bcryptjs');
const {
  authenticate, requirePermission, validatePassword, roleCeilingRefusal, roleGrantRefusal, PERMISSION_LEVELS,
} = require('../middleware/auth');
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

// ─── NOBODY GRANTS MORE THAN THEY HOLD ───
// users: full and roles: full let their holder make and change accounts and
// roles, and nothing stopped a non-administrator holding them from making an
// Admin, promoting themselves, or resetting an administrator's password.
// Every grant is now held to the granter's own access (roleCeilingRefusal).

/** The account being changed, if the caller may act on it; else a refusal. */
async function manageableUser(req, id) {
  const target = await req.app.locals.prisma.user.findUnique({
    where: { id },
    include: { role: { include: { permissions: true } } },
  });
  if (!target) return { status: 404, error: 'User not found' };
  const refusal = roleCeilingRefusal(req.user, target.role);
  return refusal ? { status: 403, error: refusal } : { target };
}

const passwordProblem = password => {
  const { valid, errors } = validatePassword(String(password));
  return valid ? null : errors.join('. ');
};

router.post('/', requirePermission('users', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, password, firstName, lastName, roleId, active } = req.body;
    if (!email || !password || !firstName) return res.status(400).json({ error: 'Missing required fields' });
    const weak = passwordProblem(password);
    if (weak) return res.status(400).json({ error: weak });
    const refusal = await roleGrantRefusal(prisma, req.user, roleId);
    if (refusal) return res.status(refusal === 'Role not found' ? 400 : 403).json({ error: refusal });

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
    const { status, error } = await manageableUser(req, req.params.id);
    if (error) return res.status(status).json({ error });

    // The account fields an administrator sets. The body went to Prisma whole,
    // portal flags and linked contacts included.
    const b = req.body || {};
    const data = {};
    for (const key of ['email', 'firstName', 'lastName', 'avatar', 'timezone', 'locale']) {
      if (b[key] !== undefined) data[key] = b[key];
    }
    if (b.active !== undefined) data.active = !!b.active;
    if (b.roleId !== undefined) {
      const refusal = await roleGrantRefusal(prisma, req.user, b.roleId);
      if (refusal) return res.status(refusal === 'Role not found' ? 400 : 403).json({ error: refusal });
      data.roleId = b.roleId;
    }
    if (b.password) {
      const weak = passwordProblem(b.password);
      if (weak) return res.status(400).json({ error: weak });
      data.password = await bcrypt.hash(b.password, 10);
    }
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
    const { status, error } = await manageableUser(req, req.params.id);
    if (error) return res.status(status).json({ error });
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

/** A role's permissions as stored: { module, level }, level none/read/edit/full. */
function permissionRows(permissions) {
  if (permissions === undefined) return { rows: undefined };
  if (!Array.isArray(permissions)) return { error: 'permissions must be a list of { module, level }' };
  const rows = [];
  for (const p of permissions) {
    if (!p || typeof p.module !== 'string' || !p.module || !(p.level in PERMISSION_LEVELS)) {
      return { error: `Each permission needs a module and a level (${Object.keys(PERMISSION_LEVELS).join(', ')})` };
    }
    rows.push({ module: p.module, level: p.level });
  }
  return { rows };
}

router.post('/roles', requirePermission('roles', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, permissions } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const { rows, error } = permissionRows(permissions);
    if (error) return res.status(400).json({ error });
    const refusal = roleCeilingRefusal(req.user, { name, permissions: rows || [] });
    if (refusal) return res.status(403).json({ error: refusal });
    const role = await prisma.role.create({
      data: {
        name: name.trim(),
        description,
        permissions: { create: rows || [] },
      },
      include: { permissions: true },
    });
    res.status(201).json(role);
  } catch (err) { next(err); }
});

router.put('/roles/:id', requirePermission('roles', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, permissions } = req.body || {};
    const current = await prisma.role.findUnique({ where: { id: req.params.id }, include: { permissions: true } });
    if (!current) return res.status(404).json({ error: 'Role not found' });
    const { rows, error } = permissionRows(permissions);
    if (error) return res.status(400).json({ error });
    // Neither a role above the editor's own access, nor one made so.
    const refusal = roleCeilingRefusal(req.user, current)
      || roleCeilingRefusal(req.user, { name: name ?? current.name, permissions: rows ?? current.permissions });
    if (refusal) return res.status(403).json({ error: refusal });

    // Replace the permissions and update the role together.
    const writes = [];
    if (rows) writes.push(prisma.permission.deleteMany({ where: { roleId: req.params.id } }));
    writes.push(prisma.role.update({
      where: { id: req.params.id },
      data: {
        name,
        description,
        ...(rows && { permissions: { create: rows } }),
      },
      include: { permissions: true },
    }));
    const role = (await prisma.$transaction(writes)).pop();
    res.json(role);
  } catch (err) { next(err); }
});

router.delete('/roles/:id', requirePermission('roles', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.role.findUnique({ where: { id: req.params.id }, include: { permissions: true } });
    if (!current) return res.status(404).json({ error: 'Role not found' });
    const refusal = roleCeilingRefusal(req.user, current);
    if (refusal) return res.status(403).json({ error: refusal });
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
      where: { createdAt: { gte: threshold } },
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
