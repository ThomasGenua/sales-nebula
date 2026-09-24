const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { isAdmin } = require('../middleware/rowSecurity');
const { reachableWhere } = require('../middleware/access');
const { columnsFrom } = require('../utils/modelFields');
const { crudModelFor } = require('../utils/crud');
const router = Router();
router.use(authenticate);

// The queue and chats are service work: reading them takes cases read, acting
// on them cases edit. Any signed-in user could read every visitor's chat and
// claim, transfer, complete, message or end anyone's item or session.

/**
 * Give the caller an item or session that is unassigned, or already theirs;
 * 409 when another agent holds it.
 */
async function claim(req, res, model, agentField, data) {
  const prisma = req.app.locals.prisma;
  const { count } = await prisma[model].updateMany({
    where: { id: req.params.id, OR: [{ [agentField]: null }, { [agentField]: req.userId }] },
    data: { ...data, [agentField]: req.userId },
  });
  const row = await prisma[model].findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!count) return res.status(409).json({ error: 'Already assigned to another agent' });
  res.json(row);
}

/** The item or session, when the caller is its assigned agent or an admin; otherwise answers and returns null. */
async function assignedToCaller(req, res, model, agentField) {
  const row = await req.app.locals.prisma[model].findUnique({ where: { id: req.params.id } });
  if (!row) { res.status(404).json({ error: 'Not found' }); return null; }
  if (row[agentField] !== req.userId && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Only the assigned agent can do this' });
    return null;
  }
  return row;
}

// Channel config
// Open to anyone signed in: a channel holds its name, type, status, routing
// type, priority, capacity, queue and skills, and no credentials.
router.get('/channels', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.omniChannel.findMany({ orderBy: { priority: 'asc' } }) }); }
  catch (err) { next(err); }
});
// The channel's own columns; the body went to the write whole.
router.post('/channels', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.omniChannel.create({ data: columnsFrom('omniChannel', req.body) })); }
  catch (err) { next(err); }
});
router.put('/channels/:id', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.omniChannel.update({ where: { id: req.params.id }, data: columnsFrom('omniChannel', req.body) })); }
  catch (err) { next(err); }
});

// Work items (routing queue)
router.get('/queue', requirePermission('cases', 'read'), async (req, res, next) => {
  try {
    const { status = 'Queued', assignedTo } = req.query;
    const where = {};
    if (status) where.status = status;
    if (assignedTo) where.assignedTo = assignedTo;
    res.json({ data: await req.app.locals.prisma.omniWorkItem.findMany({ where, orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }] }) });
  } catch (err) { next(err); }
});
// Creating a work item, like starting a chat, is cases edit; both took a
// session alone.
router.post('/route', requirePermission('cases', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { type, recordId, module, priority, skills } = req.body;
    // All three are required columns, so a missing one was a 500. The record
    // was never looked at: in a record module it must be one the caller can see.
    if (![type, recordId, module].every(v => typeof v === 'string' && v)) {
      return res.status(400).json({ error: 'type, recordId and module required' });
    }
    const model = crudModelFor(module);
    if (model) {
      if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
      const record = await prisma[model].findFirst({ where: await reachableWhere(req, module, model, { id: recordId }), select: { id: true } });
      if (!record) return res.status(404).json({ error: 'Record not found' });
    }
    const item = await prisma.omniWorkItem.create({ data: { type, recordId, module, priority: priority || 5, skills: skills || [] } });
    // Auto-route based on channel config, passing over agents whose presence
    // says they are not available: the check a second POST /route handler
    // made, which this one shadowed, so it never ran.
    const channels = await prisma.omniChannel.findMany({ where: { status: 'Online' }, orderBy: { priority: 'asc' } });
    for (const ch of channels) {
      if (ch.routingType === 'Least Active') {
        // The available staff agent with the fewest open items, counting
        // those with none. Load was counted only for agents already holding
        // an Active item, so an idle agent was never picked, and routed items
        // not yet accepted (Assigned) counted against no one.
        const presence = await prisma.agentPresence.findMany({ select: { userId: true, status: true } });
        const away = new Set(presence.filter(p => !['available', 'Available'].includes(p.status)).map(p => p.userId));
        const load = new Map(presence.filter(p => !away.has(p.userId)).map(p => [p.userId, 0]));
        const open = await prisma.omniWorkItem.groupBy({ by: ['assignedTo'], where: { status: { in: ['Assigned', 'Active'] }, assignedTo: { not: null } }, _count: true });
        for (const a of open) if (!away.has(a.assignedTo)) load.set(a.assignedTo, a._count);
        const staff = new Set((await prisma.user.findMany({ where: { id: { in: [...load.keys()] }, active: true, isPortalUser: false }, select: { id: true } })).map(u => u.id));
        const [agent] = [...load].filter(([userId]) => staff.has(userId)).sort((a, b) => a[1] - b[1]);
        if (agent) {
          await prisma.omniWorkItem.update({ where: { id: item.id }, data: { assignedTo: agent[0], status: 'Assigned', assignedAt: new Date(), channelId: ch.id } });
          break;
        }
      }
    }
    res.status(201).json(await prisma.omniWorkItem.findUnique({ where: { id: item.id } }));
  } catch (err) { next(err); }
});
router.post('/queue/:id/accept', requirePermission('cases', 'edit'), async (req, res, next) => {
  try { await claim(req, res, 'omniWorkItem', 'assignedTo', { status: 'Active', assignedAt: new Date() }); }
  catch (err) { next(err); }
});
router.post('/queue/:id/complete', requirePermission('cases', 'edit'), async (req, res, next) => {
  try {
    const item = await assignedToCaller(req, res, 'omniWorkItem', 'assignedTo');
    if (!item) return;
    const handleTime = item.assignedAt ? Math.round((Date.now() - new Date(item.assignedAt).getTime()) / 1000) : 0;
    const waitTime = item.assignedAt ? Math.round((new Date(item.assignedAt).getTime() - new Date(item.queuedAt).getTime()) / 1000) : 0;
    res.json(await req.app.locals.prisma.omniWorkItem.update({ where: { id: req.params.id }, data: { status: 'Completed', completedAt: new Date(), handleTime, waitTime } }));
  } catch (err) { next(err); }
});
router.post('/queue/:id/transfer', requirePermission('cases', 'edit'), async (req, res, next) => {
  try {
    if (!(await assignedToCaller(req, res, 'omniWorkItem', 'assignedTo'))) return;
    // toUserId was stored as sent: no one, a disabled account, or a customer's
    // portal account could be handed the item.
    const to = req.body.toUserId && await req.app.locals.prisma.user.findFirst({
      where: { id: String(req.body.toUserId), active: true, isPortalUser: false }, select: { id: true },
    });
    if (!to) return res.status(400).json({ error: 'toUserId does not name an active staff user' });
    res.json(await req.app.locals.prisma.omniWorkItem.update({ where: { id: req.params.id }, data: { status: 'Assigned', assignedTo: to.id, assignedAt: new Date() } }));
  } catch (err) { next(err); }
});

// Chat sessions
router.get('/chat', requirePermission('cases', 'read'), async (req, res, next) => {
  try {
    const { status, agentId } = req.query;
    const where = {};
    if (status) where.status = status;
    if (agentId) where.agentId = agentId;
    res.json({ data: await req.app.locals.prisma.chatSession.findMany({ where, orderBy: { startedAt: 'desc' }, take: 50 }) });
  } catch (err) { next(err); }
});
router.post('/chat', requirePermission('cases', 'edit'), async (req, res, next) => {
  try {
    const session = await req.app.locals.prisma.chatSession.create({
      data: { visitorId: req.body.visitorId || 'anon', visitorName: req.body.visitorName, visitorEmail: req.body.visitorEmail, channel: req.body.channel || 'web', department: req.body.department, transcript: [] },
    });
    res.status(201).json(session);
  } catch (err) { next(err); }
});
router.post('/chat/:id/accept', requirePermission('cases', 'edit'), async (req, res, next) => {
  try { await claim(req, res, 'chatSession', 'agentId', { status: 'Active' }); }
  catch (err) { next(err); }
});
router.post('/chat/:id/message', requirePermission('cases', 'edit'), async (req, res, next) => {
  try {
    const session = await assignedToCaller(req, res, 'chatSession', 'agentId');
    if (!session) return;
    const transcript = [...(session.transcript || []), { sender: req.body.sender || 'agent', message: req.body.message, timestamp: new Date() }];
    res.json(await req.app.locals.prisma.chatSession.update({ where: { id: req.params.id }, data: { transcript } }));
  } catch (err) { next(err); }
});
router.post('/chat/:id/end', requirePermission('cases', 'edit'), async (req, res, next) => {
  try {
    if (!(await assignedToCaller(req, res, 'chatSession', 'agentId'))) return;
    res.json(await req.app.locals.prisma.chatSession.update({ where: { id: req.params.id }, data: { status: 'Ended', endedAt: new Date(), rating: req.body.rating } }));
  } catch (err) { next(err); }
});

module.exports = router;

// Queue statistics
// Service work, so cases read; it answered anyone signed in.
router.get('/queues/stats', authenticate, requirePermission('cases', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const queues = await prisma.omnichannelQueue.findMany({ where: { active: true } }).catch(() => []);
    const stats = [];
    for (const q of queues) {
      const waiting = await prisma.omnichannelItem.count({ where: { queueId: q.id, status: 'waiting' } }).catch(() => 0);
      const inProgress = await prisma.omnichannelItem.count({ where: { queueId: q.id, status: 'in_progress' } }).catch(() => 0);
      stats.push({ queue: q.name, queueId: q.id, waiting, inProgress, avgWaitMinutes: q.avgWaitMinutes || 0 });
    }
    res.json(stats);
  } catch (err) { next(err); }
});

// Agent presence
// It says who takes routed service work, so it is cases edit, and it is the
// caller's own: only an admin may set another agent's (`userId`). This was an
// upsert on userId, which is not unique, so Prisma refused it and the catch
// answered with the request echoed back; no presence was ever stored.
router.post('/presence', authenticate, requirePermission('cases', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, capacity } = req.body;
    if ((status != null && typeof status !== 'string') || (capacity != null && !Number.isInteger(capacity))) {
      return res.status(400).json({ error: 'status must be text and capacity a whole number' });
    }
    const userId = req.body.userId ? String(req.body.userId) : req.user.id;
    if (userId !== req.user.id) {
      if (!isAdmin(req.user)) return res.status(403).json({ error: 'You can only set your own presence' });
      if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) return res.status(400).json({ error: 'userId does not name a user' });
    }
    const existing = await prisma.agentPresence.findFirst({ where: { userId } });
    const presence = existing
      ? await prisma.agentPresence.update({ where: { id: existing.id }, data: { status: status || 'available', ...(capacity != null && { capacity }), lastPing: new Date() } })
      : await prisma.agentPresence.create({ data: { userId, status: status || 'available', capacity: capacity || 5, lastPing: new Date() } });
    res.json(presence);
  } catch (err) { next(err); }
});

// Channel metrics
// Case counts: cases read, over the live cases the caller can see. They
// counted every case for anyone signed in.
router.get('/channels/metrics', authenticate, requirePermission('cases', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const channels = ['phone','email','chat','social','web'];
    const recent = await reachableWhere(req, 'cases', 'case', { createdAt: { gte: new Date(Date.now() - 30*86400000) } });
    const metrics = [];
    for (const ch of channels) {
      // Case origins are written capitalised ('Email', 'Web', 'Phone'), so an
      // exact match on these names counted nothing.
      const count = await prisma.case.count({ where: { AND: [recent, { origin: { equals: ch, mode: 'insensitive' } }] } }).catch(() => 0);
      metrics.push({ channel: ch, casesLast30Days: count });
    }
    res.json(metrics);
  } catch (err) { next(err); }
});
