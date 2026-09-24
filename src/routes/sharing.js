const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── SHARING RULES CRUD ───

// List sharing rules
router.get('/rules', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.query;
    const where = module ? { module } : {};
    const rules = await prisma.sharingRule.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: rules });
  } catch (err) { next(err); }
});

// Create sharing rule
router.post('/rules', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, type, sharedFrom, sharedTo, accessLevel, active } = req.body;
    if (!name || !module || !type) {
      return res.status(400).json({ error: 'name, module, and type required' });
    }

    const rule = await prisma.sharingRule.create({
      data: {
        name, module, type,
        sharedFrom: sharedFrom || null,
        sharedTo: sharedTo || null,
        accessLevel: accessLevel || 'read',
        active: active !== false,
        createdById: req.userId,
      },
    });

    await req.audit({ action: 'create', module: 'settings', recordId: rule.id, details: `Created sharing rule: ${name}` });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// Update sharing rule
router.put('/rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, sharedFrom, sharedTo, accessLevel, active } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (sharedFrom !== undefined) data.sharedFrom = sharedFrom;
    if (sharedTo !== undefined) data.sharedTo = sharedTo;
    if (accessLevel !== undefined) data.accessLevel = accessLevel;
    if (active !== undefined) data.active = active;

    const rule = await prisma.sharingRule.update({ where: { id: req.params.id }, data });
    res.json(rule);
  } catch (err) { next(err); }
});

// Delete sharing rule
router.delete('/rules/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.sharingRule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── RECORD-LEVEL SHARING ───

// Share a specific record with a user
// Only a live record the caller may change, with an active user, at no more
// than the caller holds: sharing takes edit on the module and Edit on the
// record, and granting full takes full on both. This took any module, record,
// user and level from anyone signed in.
router.post('/records', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, userId, accessLevel } = req.body;
    if (!module || !recordId || !userId) {
      return res.status(400).json({ error: 'module, recordId, userId required' });
    }
    const level = String(accessLevel || 'read').toLowerCase();
    if (!['read', 'edit', 'full'].includes(level)) return res.status(400).json({ error: 'accessLevel must be read, edit or full' });
    const modelName = typeof module === 'string' ? crudModelFor(module) : null;
    if (!modelName) return res.status(400).json({ error: `Sharing is not available for ${module}` });
    if (!permits(req, module, level === 'full' ? 'full' : 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const record = await prisma[modelName].findFirst({
      where: await reachableWhere(req, module, modelName, { id: String(recordId) }, level === 'full' ? 'Full' : 'Edit'),
      select: { id: true },
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    const user = await prisma.user.findFirst({ where: { id: String(userId), active: true }, select: { id: true } });
    if (!user) return res.status(400).json({ error: 'userId does not name an active user' });

    const share = await prisma.recordShare.create({
      data: {
        module, recordId: record.id,
        sharedWithId: user.id,
        accessLevel: level,
        sharedById: req.userId,
      },
    });

    res.status(201).json(share);
  } catch (err) { next(err); }
});

// List who a record is shared with
// Only for a record the caller can see, with the module's read permission:
// this listed the shares on any record, and who they went to.
router.get('/records/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    const modelName = crudModelFor(module);
    if (!modelName) return res.status(400).json({ error: `Sharing is not available for ${module}` });
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const record = await prisma[modelName].findFirst({
      where: await reachableWhere(req, module, modelName, { id: String(recordId) }),
      select: { id: true },
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    const shares = await prisma.recordShare.findMany({
      where: { module, recordId: record.id },
    });

    // Hydrate user info
    const userIds = [...new Set(shares.map(s => s.sharedWithId))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const data = shares.map(s => ({
      ...s,
      sharedWith: userMap[s.sharedWithId] || null,
    }));

    res.json({ data });
  } catch (err) { next(err); }
});

// Remove record share
// By whoever shared it, an admin, or someone who may change the record: the
// module's edit permission and Edit on the record. Anyone signed in could
// delete any share.
router.delete('/records/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const share = await prisma.recordShare.findUnique({ where: { id: req.params.id } });
    if (!share) return res.status(404).json({ error: 'Not found' });
    if (share.sharedById !== req.userId && !isAdmin(req.user)) {
      const modelName = crudModelFor(share.module);
      if (modelName && !permits(req, share.module, 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${share.module}` });
      const record = modelName && await prisma[modelName].findFirst({
        where: await reachableWhere(req, share.module, modelName, { id: share.recordId }, 'Edit'),
        select: { id: true },
      });
      if (!record) return res.status(404).json({ error: 'Not found' });
    }
    await prisma.recordShare.delete({ where: { id: share.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── CHECK ACCESS (utility endpoint for frontend) ───
router.get('/check/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;

    // Check direct record share
    const directShare = await prisma.recordShare.findFirst({
      where: { module, recordId, sharedWithId: req.userId },
    });

    // Check sharing rules
    const rules = await prisma.sharingRule.findMany({
      where: { module, active: true },
    });

    const access = {
      hasAccess: !!directShare || rules.length > 0,
      accessLevel: directShare?.accessLevel || (rules.length > 0 ? 'read' : 'none'),
      via: directShare ? 'direct' : (rules.length > 0 ? 'rule' : 'none'),
    };

    res.json(access);
  } catch (err) { next(err); }
});

module.exports = router;
