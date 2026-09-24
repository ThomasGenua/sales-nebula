const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { columnsFrom } = require('../utils/modelFields');
const {
  getUserGroupIds, expandGroupHierarchy, invalidateGroupCache,
  applyAutoAssignRules, isAdmin,
} = require('../middleware/rowSecurity');

const router = Router();

const SECURABLE_MODULES = [
  'contacts', 'leads', 'deals', 'accounts', 'cases', 'activities',
  'quotes', 'invoices', 'contracts', 'orders', 'products', 'campaigns',
  'documents', 'projects', 'subscriptions', 'assets',
];

// ── GROUPS ────────────────────────────────────────────────────────────

// Security groups decide who sees which records. Changing them took only
// admin: edit, which the default Sales Rep role has, so a rep could join any
// group, or put any record into theirs, and read or edit it. Changing them
// now takes admin: full; looking at them, admin: read (it took nothing).
router.get('/', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { search, active, page = 1, limit = 50 } = req.query;
    const where = { deletedAt: null };
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];
    if (active !== undefined) where.active = active === 'true';

    const [data, total] = await Promise.all([
      prisma.securityGroup.findMany({
        where, skip: (+page - 1) * +limit, take: +limit, orderBy: { name: 'asc' },
        include: { _count: { select: { members: true, records: true, childGroups: true } } },
      }),
      prisma.securityGroup.count({ where }),
    ]);
    res.json({ data, total, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const group = await prisma.securityGroup.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        members: true,
        childGroups: { select: { id: true, name: true, active: true } },
        parentGroup: { select: { id: true, name: true } },
        roleLinks: true,
        _count: { select: { records: true } },
      },
    });
    if (!group) return res.status(404).json({ error: 'Security group not found' });

    const byModule = await prisma.securityGroupRecord.groupBy({
      where: { securityGroupId: group.id }, by: ['module'], _count: true,
    });
    res.json({ ...group, recordsByModule: byModule.map(m => ({ module: m.module, count: m._count })) });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, parentGroupId, isNonInheritable, isPrimaryGroup, autoAssign, userIds } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const dupe = await prisma.securityGroup.findFirst({ where: { name, deletedAt: null } });
    if (dupe) return res.status(409).json({ error: 'A group with that name already exists' });

    if (parentGroupId) {
      const parent = await prisma.securityGroup.findFirst({ where: { id: parentGroupId, deletedAt: null } });
      if (!parent) return res.status(400).json({ error: 'parentGroupId not found' });
    }

    const group = await prisma.securityGroup.create({
      data: {
        name, description, parentGroupId: parentGroupId || null,
        isNonInheritable: !!isNonInheritable, isPrimaryGroup: !!isPrimaryGroup,
        autoAssign: !!autoAssign, createdById: req.user.id,
      },
    });

    for (const uid of userIds || []) {
      await prisma.securityGroupUser.create({ data: { securityGroupId: group.id, userId: uid, addedById: req.user.id } }).catch(() => {});
    }
    invalidateGroupCache();

    await req.audit({ action: 'create', module: 'securityGroups', recordId: group.id, details: `Security group created: ${name}` });
    res.status(201).json(group);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The group's own columns; members, records and links change through
    // their own routes, and relation keys here were nested writes.
    const data = columnsFrom('securityGroup', req.body);

    // Reparenting must not create a loop
    if (data.parentGroupId) {
      if (data.parentGroupId === req.params.id) return res.status(400).json({ error: 'A group cannot be its own parent' });
      let cursor = data.parentGroupId, guard = 0;
      while (cursor && guard++ < 30) {
        if (cursor === req.params.id) return res.status(400).json({ error: 'That change would create a circular group hierarchy' });
        const p = await prisma.securityGroup.findUnique({ where: { id: cursor }, select: { parentGroupId: true } });
        cursor = p?.parentGroupId;
      }
    }

    const group = await prisma.securityGroup.update({ where: { id: req.params.id }, data });
    invalidateGroupCache();
    await req.audit({ action: 'update', module: 'securityGroups', recordId: group.id, details: `Security group updated: ${group.name}` });
    res.json(group);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const group = await prisma.securityGroup.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!group) return res.status(404).json({ error: 'Security group not found' });

    const children = await prisma.securityGroup.count({ where: { parentGroupId: group.id, deletedAt: null } });
    if (children > 0 && req.query.force !== 'true') {
      return res.status(409).json({ error: `Group has ${children} child groups. Pass force=true to reparent them to root.` });
    }
    if (children > 0) {
      await prisma.securityGroup.updateMany({ where: { parentGroupId: group.id }, data: { parentGroupId: group.parentGroupId } });
    }

    await prisma.securityGroup.update({ where: { id: group.id }, data: { deletedAt: new Date(), active: false } });
    invalidateGroupCache();
    await req.audit({ action: 'delete', module: 'securityGroups', recordId: group.id, details: `Security group deleted: ${group.name}` });
    res.json({ deleted: true, childrenReparented: children });
  } catch (err) { next(err); }
});

// Group hierarchy tree
router.get('/tree/all', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const groups = await prisma.securityGroup.findMany({
      where: { deletedAt: null },
      include: { _count: { select: { members: true, records: true } } },
      orderBy: { name: 'asc' },
    });
    const byParent = new Map();
    for (const g of groups) {
      const key = g.parentGroupId || '__root__';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(g);
    }
    const build = (key, depth) => (byParent.get(key) || []).map(g => ({
      ...g, depth, children: depth < 10 ? build(g.id, depth + 1) : [],
    }));
    res.json(build('__root__', 0));
  } catch (err) { next(err); }
});

// ── MEMBERSHIP ────────────────────────────────────────────────────────

router.get('/:id/members', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const members = await prisma.securityGroupUser.findMany({
      where: { securityGroupId: req.params.id },
      orderBy: [{ isGroupAdmin: 'desc' }, { createdAt: 'asc' }],
    });
    const userIds = members.map(m => m.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true, active: true },
    });
    const byId = new Map(users.map(u => [u.id, u]));
    res.json(members.map(m => ({ ...m, user: byId.get(m.userId) || null })));
  } catch (err) { next(err); }
});

router.post('/:id/members', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userIds, isGroupAdmin, primaryGroup } = req.body;
    const list = userIds || (req.body.userId ? [req.body.userId] : []);
    if (!list.length) return res.status(400).json({ error: 'userIds required' });

    const group = await prisma.securityGroup.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!group) return res.status(404).json({ error: 'Security group not found' });

    const added = [];
    for (const uid of list) {
      const existing = await prisma.securityGroupUser.findFirst({ where: { securityGroupId: group.id, userId: uid } });
      if (existing) continue;
      added.push(await prisma.securityGroupUser.create({
        data: { securityGroupId: group.id, userId: uid, isGroupAdmin: !!isGroupAdmin, primaryGroup: !!primaryGroup, addedById: req.user.id },
      }));
      invalidateGroupCache(uid);
    }
    await req.audit({ action: 'update', module: 'securityGroups', recordId: group.id, details: `${added.length} members added to ${group.name}` });
    res.status(201).json({ added: added.length, members: added });
  } catch (err) { next(err); }
});

router.delete('/:id/members/:userId', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const result = await prisma.securityGroupUser.deleteMany({ where: { securityGroupId: req.params.id, userId: req.params.userId } });
    invalidateGroupCache(req.params.userId);
    await req.audit({ action: 'update', module: 'securityGroups', recordId: req.params.id, details: `Member removed: ${req.params.userId}` });
    res.json({ removed: result.count });
  } catch (err) { next(err); }
});

// Which groups a user belongs to, including inherited
router.get('/user/:userId/groups', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (req.params.userId !== req.user.id && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'You can only view your own group memberships' });
    }
    const direct = await prisma.securityGroupUser.findMany({
      where: { userId: req.params.userId },
      include: { securityGroup: { select: { id: true, name: true, active: true, parentGroupId: true } } },
    });
    const effectiveIds = await getUserGroupIds(prisma, req.params.userId, { useCache: false });
    const inheritedIds = effectiveIds.filter(id => !direct.some(d => d.securityGroupId === id));
    const inherited = inheritedIds.length
      ? await prisma.securityGroup.findMany({ where: { id: { in: inheritedIds } }, select: { id: true, name: true } })
      : [];
    res.json({ userId: req.params.userId, direct: direct.map(d => ({ ...d.securityGroup, isGroupAdmin: d.isGroupAdmin })), inherited, effectiveGroupCount: effectiveIds.length });
  } catch (err) { next(err); }
});

// ── RECORD ASSIGNMENT ─────────────────────────────────────────────────

router.get('/:id/records', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, page = 1, limit = 100 } = req.query;
    const where = { securityGroupId: req.params.id };
    if (module) where.module = module;
    const [data, total] = await Promise.all([
      prisma.securityGroupRecord.findMany({ where, skip: (+page - 1) * +limit, take: +limit, orderBy: { createdAt: 'desc' } }),
      prisma.securityGroupRecord.count({ where }),
    ]);
    res.json({ data, total, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

router.post('/:id/records', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds, accessLevel = 'Full' } = req.body;
    if (!module || !recordIds?.length) return res.status(400).json({ error: 'module and recordIds required' });
    if (!SECURABLE_MODULES.includes(module)) return res.status(400).json({ error: `module must be one of: ${SECURABLE_MODULES.join(', ')}` });
    if (!['Read', 'Edit', 'Full'].includes(accessLevel)) return res.status(400).json({ error: 'accessLevel must be Read, Edit, or Full' });

    const group = await prisma.securityGroup.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!group) return res.status(404).json({ error: 'Security group not found' });

    let assigned = 0;
    for (const recordId of recordIds.slice(0, 5000)) {
      await prisma.securityGroupRecord.create({
        data: { securityGroupId: group.id, module, recordId, accessLevel, assignedById: req.user.id },
      }).then(() => assigned++).catch(() => {});
    }
    await req.audit({ action: 'update', module: 'securityGroups', recordId: group.id, details: `${assigned} ${module} records assigned to ${group.name}` });
    res.status(201).json({ assigned, requested: recordIds.length });
  } catch (err) { next(err); }
});

router.delete('/:id/records', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds } = req.body;
    if (!module) return res.status(400).json({ error: 'module required' });
    const where = { securityGroupId: req.params.id, module };
    if (recordIds?.length) where.recordId = { in: recordIds };
    const result = await prisma.securityGroupRecord.deleteMany({ where });
    await req.audit({ action: 'update', module: 'securityGroups', recordId: req.params.id, details: `${result.count} ${module} records unassigned` });
    res.json({ removed: result.count });
  } catch (err) { next(err); }
});

// Which groups control a given record
router.get('/record/:module/:recordId', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const assignments = await prisma.securityGroupRecord.findMany({
      where: { module: req.params.module, recordId: req.params.recordId },
      include: { securityGroup: { select: { id: true, name: true, active: true } } },
    });
    const myGroups = await getUserGroupIds(prisma, req.user.id);
    res.json({
      module: req.params.module, recordId: req.params.recordId,
      isRestricted: assignments.length > 0,
      assignments,
      youHaveAccess: isAdmin(req.user) || !assignments.length || assignments.some(a => myGroups.includes(a.securityGroupId)),
    });
  } catch (err) { next(err); }
});

// Mass assign across a filtered set
router.post('/mass-assign', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, securityGroupIds, filters, accessLevel = 'Full', limit = 1000 } = req.body;
    if (!module || !securityGroupIds?.length) return res.status(400).json({ error: 'module and securityGroupIds required' });
    if (!SECURABLE_MODULES.includes(module)) return res.status(400).json({ error: `Unsupported module: ${module}` });

    const modelMap = {
      contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
      cases: 'case', activities: 'activity', quotes: 'quote', invoices: 'invoice',
      contracts: 'contract', orders: 'order', products: 'product', campaigns: 'campaign',
      documents: 'document', projects: 'project', subscriptions: 'subscription', assets: 'asset',
    };
    const model = modelMap[module];

    const where = { deletedAt: null };
    if (filters?.ownerId) where.ownerId = filters.ownerId;
    if (filters?.status) where.status = filters.status;
    if (filters?.createdAfter) where.createdAt = { gte: new Date(filters.createdAfter) };

    const records = await prisma[model].findMany({ where, select: { id: true }, take: Math.min(+limit, 5000) });

    let assigned = 0;
    for (const groupId of securityGroupIds) {
      for (const r of records) {
        await prisma.securityGroupRecord.create({
          data: { securityGroupId: groupId, module, recordId: r.id, accessLevel, assignedById: req.user.id },
        }).then(() => assigned++).catch(() => {});
      }
    }
    await req.audit({ action: 'update', module: 'securityGroups', recordId: 'mass-assign', details: `Mass assigned ${assigned} ${module} records across ${securityGroupIds.length} groups` });
    res.json({ matched: records.length, assigned, groups: securityGroupIds.length });
  } catch (err) { next(err); }
});

// ── AUTO-ASSIGN RULES ─────────────────────────────────────────────────

router.get('/rules/list', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { deletedAt: null };
    if (req.query.module) where.module = req.query.module;
    const rules = await prisma.securityGroupRule.findMany({ where, orderBy: [{ module: 'asc' }, { priority: 'asc' }] });
    res.json(rules);
  } catch (err) { next(err); }
});

router.post('/rules', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, conditions, securityGroupId, priority, applyOnCreate, applyOnUpdate } = req.body;
    if (!name || !module || !securityGroupId) return res.status(400).json({ error: 'name, module, and securityGroupId required' });
    if (!SECURABLE_MODULES.includes(module)) return res.status(400).json({ error: `Unsupported module: ${module}` });
    if (!Array.isArray(conditions) || !conditions.length) return res.status(400).json({ error: 'conditions array required' });

    const validOps = ['equals', 'notEquals', 'contains', 'startsWith', 'greaterThan', 'lessThan', 'isEmpty', 'isNotEmpty', 'in'];
    for (const c of conditions) {
      if (!c.field || !validOps.includes(c.operator)) {
        return res.status(400).json({ error: `Each condition needs a field and one of these operators: ${validOps.join(', ')}` });
      }
    }

    const rule = await prisma.securityGroupRule.create({
      data: { name, module, conditions, securityGroupId, priority: priority ?? 0, applyOnCreate: applyOnCreate !== false, applyOnUpdate: !!applyOnUpdate },
    });
    await req.audit({ action: 'create', module: 'securityGroups', recordId: rule.id, details: `Auto-assign rule created: ${name}` });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/rules/:ruleId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.securityGroupRule.update({ where: { id: req.params.ruleId }, data: columnsFrom('securityGroupRule', req.body) });
    res.json(rule);
  } catch (err) { next(err); }
});

router.delete('/rules/:ruleId', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.securityGroupRule.update({ where: { id: req.params.ruleId }, data: { deletedAt: new Date(), active: false } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Dry-run a rule to preview what it would capture
router.post('/rules/:ruleId/preview', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.securityGroupRule.findFirst({ where: { id: req.params.ruleId, deletedAt: null } });
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    const modelMap = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', activities: 'activity', quotes: 'quote', invoices: 'invoice', contracts: 'contract', orders: 'order', products: 'product', campaigns: 'campaign', documents: 'document', projects: 'project', subscriptions: 'subscription', assets: 'asset' };
    const model = modelMap[rule.module];
    if (!model) return res.status(400).json({ error: 'Unsupported module on rule' });

    const sample = await prisma[model].findMany({ where: { deletedAt: null }, take: 500 });
    const matched = [];
    for (const rec of sample) {
      const applied = await applyAutoAssignRules({ securityGroupRule: { findMany: async () => [rule] }, securityGroupRecord: { create: async () => {} } }, rule.module, rec);
      if (applied.length) matched.push({ id: rec.id, name: rec.name || rec.title || rec.subject || `${rec.firstName || ''} ${rec.lastName || ''}`.trim() });
    }
    res.json({ ruleId: rule.id, sampleSize: sample.length, wouldMatch: matched.length, sample: matched.slice(0, 25) });
  } catch (err) { next(err); }
});

// ── DIAGNOSTICS ───────────────────────────────────────────────────────

// Explain why a user can or cannot see a record
router.get('/explain/:module/:recordId', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const userId = req.query.userId || req.user.id;
    const { module, recordId } = req.params;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, role: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const assignments = await prisma.securityGroupRecord.findMany({
      where: { module, recordId },
      include: { securityGroup: { select: { id: true, name: true } } },
    });
    const userGroups = await getUserGroupIds(prisma, userId, { useCache: false });
    const matching = assignments.filter(a => userGroups.includes(a.securityGroupId));

    const reasons = [];
    let hasAccess = false;
    if (isAdmin(user)) { hasAccess = true; reasons.push('User is an administrator and bypasses row-level security'); }
    else if (!assignments.length) { hasAccess = true; reasons.push('Record is not assigned to any security group, so it is unrestricted'); }
    else if (matching.length) { hasAccess = true; reasons.push(`User belongs to ${matching.length} group(s) that control this record: ${matching.map(m => m.securityGroup.name).join(', ')}`); }
    else { reasons.push(`Record is controlled by ${assignments.length} group(s) the user does not belong to: ${assignments.map(a => a.securityGroup.name).join(', ')}`); }

    res.json({
      user: { id: user.id, name: `${user.firstName || ''} ${user.lastName || ''}`.trim() },
      module, recordId, hasAccess, reasons,
      recordGroups: assignments.map(a => ({ id: a.securityGroupId, name: a.securityGroup.name, accessLevel: a.accessLevel })),
      userGroupCount: userGroups.length,
    });
  } catch (err) { next(err); }
});

router.get('/analytics/coverage', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const modelMap = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', projects: 'project' };
    const coverage = [];
    for (const [module, model] of Object.entries(modelMap)) {
      try {
        const total = await prisma[model].count({ where: { deletedAt: null } });
        const secured = await prisma.securityGroupRecord.findMany({ where: { module }, select: { recordId: true }, distinct: ['recordId'] });
        coverage.push({ module, totalRecords: total, securedRecords: secured.length, unsecured: total - secured.length, coveragePercent: total ? +((secured.length / total) * 100).toFixed(1) : 0 });
      } catch (e) { /* model may not expose deletedAt */ }
    }
    const groups = await prisma.securityGroup.count({ where: { deletedAt: null, active: true } });
    const memberships = await prisma.securityGroupUser.count();
    res.json({ activeGroups: groups, totalMemberships: memberships, coverage });
  } catch (err) { next(err); }
});

// Groups with no members or no records
router.get('/analytics/orphans', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const groups = await prisma.securityGroup.findMany({
      where: { deletedAt: null },
      include: { _count: { select: { members: true, records: true } } },
    });
    res.json({
      noMembers: groups.filter(g => g._count.members === 0).map(g => ({ id: g.id, name: g.name })),
      noRecords: groups.filter(g => g._count.records === 0).map(g => ({ id: g.id, name: g.name })),
      empty: groups.filter(g => g._count.members === 0 && g._count.records === 0).map(g => ({ id: g.id, name: g.name })),
    });
  } catch (err) { next(err); }
});

// Clear the membership cache after bulk changes
router.post('/cache/invalidate', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  invalidateGroupCache(req.body.userId);
  res.json({ invalidated: true, scope: req.body.userId || 'all' });
});

module.exports = router;
