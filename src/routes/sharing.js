const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

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
router.post('/records', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, userId, accessLevel } = req.body;
    if (!module || !recordId || !userId) {
      return res.status(400).json({ error: 'module, recordId, userId required' });
    }

    const share = await prisma.recordShare.create({
      data: {
        module, recordId,
        sharedWithId: userId,
        accessLevel: accessLevel || 'read',
        sharedById: req.userId,
      },
    });

    res.status(201).json(share);
  } catch (err) { next(err); }
});

// List who a record is shared with
router.get('/records/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    const shares = await prisma.recordShare.findMany({
      where: { module, recordId },
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
router.delete('/records/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.recordShare.delete({ where: { id: req.params.id } });
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
