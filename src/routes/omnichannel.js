const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const router = Router();
router.use(authenticate);

// Channel config
router.get('/channels', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.omniChannel.findMany({ orderBy: { priority: 'asc' } }) }); }
  catch (err) { next(err); }
});
router.post('/channels', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.omniChannel.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.put('/channels/:id', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.omniChannel.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { next(err); }
});

// Work items (routing queue)
router.get('/queue', async (req, res, next) => {
  try {
    const { status = 'Queued', assignedTo } = req.query;
    const where = {};
    if (status) where.status = status;
    if (assignedTo) where.assignedTo = assignedTo;
    res.json({ data: await req.app.locals.prisma.omniWorkItem.findMany({ where, orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }] }) });
  } catch (err) { next(err); }
});
router.post('/route', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { type, recordId, module, priority, skills } = req.body;
    const item = await prisma.omniWorkItem.create({ data: { type, recordId, module, priority: priority || 5, skills: skills || [] } });
    // Auto-route based on channel config
    const channels = await prisma.omniChannel.findMany({ where: { status: 'Online' }, orderBy: { priority: 'asc' } });
    for (const ch of channels) {
      if (ch.routingType === 'Least Active') {
        const agents = await prisma.omniWorkItem.groupBy({ by: ['assignedTo'], where: { status: 'Active' }, _count: true, orderBy: { _count: { assignedTo: 'asc' } } });
        if (agents.length > 0) {
          await prisma.omniWorkItem.update({ where: { id: item.id }, data: { assignedTo: agents[0].assignedTo, status: 'Assigned', assignedAt: new Date(), channelId: ch.id } });
          break;
        }
      }
    }
    res.status(201).json(await prisma.omniWorkItem.findUnique({ where: { id: item.id } }));
  } catch (err) { next(err); }
});
router.post('/queue/:id/accept', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.omniWorkItem.update({ where: { id: req.params.id }, data: { status: 'Active', assignedTo: req.userId, assignedAt: new Date() } })); }
  catch (err) { next(err); }
});
router.post('/queue/:id/complete', async (req, res, next) => {
  try {
    const item = await req.app.locals.prisma.omniWorkItem.findUnique({ where: { id: req.params.id } });
    const handleTime = item.assignedAt ? Math.round((Date.now() - new Date(item.assignedAt).getTime()) / 1000) : 0;
    const waitTime = item.assignedAt ? Math.round((new Date(item.assignedAt).getTime() - new Date(item.queuedAt).getTime()) / 1000) : 0;
    res.json(await req.app.locals.prisma.omniWorkItem.update({ where: { id: req.params.id }, data: { status: 'Completed', completedAt: new Date(), handleTime, waitTime } }));
  } catch (err) { next(err); }
});
router.post('/queue/:id/transfer', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.omniWorkItem.update({ where: { id: req.params.id }, data: { status: 'Assigned', assignedTo: req.body.toUserId, assignedAt: new Date() } })); }
  catch (err) { next(err); }
});

// Chat sessions
router.get('/chat', async (req, res, next) => {
  try {
    const { status, agentId } = req.query;
    const where = {};
    if (status) where.status = status;
    if (agentId) where.agentId = agentId;
    res.json({ data: await req.app.locals.prisma.chatSession.findMany({ where, orderBy: { startedAt: 'desc' }, take: 50 }) });
  } catch (err) { next(err); }
});
router.post('/chat', async (req, res, next) => {
  try {
    const session = await req.app.locals.prisma.chatSession.create({
      data: { visitorId: req.body.visitorId || 'anon', visitorName: req.body.visitorName, visitorEmail: req.body.visitorEmail, channel: req.body.channel || 'web', department: req.body.department, transcript: [] },
    });
    res.status(201).json(session);
  } catch (err) { next(err); }
});
router.post('/chat/:id/accept', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.chatSession.update({ where: { id: req.params.id }, data: { agentId: req.userId, status: 'Active' } })); }
  catch (err) { next(err); }
});
router.post('/chat/:id/message', async (req, res, next) => {
  try {
    const session = await req.app.locals.prisma.chatSession.findUnique({ where: { id: req.params.id } });
    const transcript = [...(session.transcript || []), { sender: req.body.sender || 'agent', message: req.body.message, timestamp: new Date() }];
    res.json(await req.app.locals.prisma.chatSession.update({ where: { id: req.params.id }, data: { transcript } }));
  } catch (err) { next(err); }
});
router.post('/chat/:id/end', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.chatSession.update({ where: { id: req.params.id }, data: { status: 'Ended', endedAt: new Date(), rating: req.body.rating } })); }
  catch (err) { next(err); }
});

module.exports = router;

// Queue statistics
router.get('/queues/stats', authenticate, async (req, res, next) => {
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
router.post('/presence', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, capacity } = req.body;
    const presence = await prisma.agentPresence.upsert({
      where: { userId: req.user.id },
      update: { status: status || 'available', capacity, lastPing: new Date() },
      create: { userId: req.user.id, status: status || 'available', capacity: capacity || 5, lastPing: new Date() },
    }).catch(() => ({ userId: req.user.id, status }));
    res.json(presence);
  } catch (err) { next(err); }
});

// Route work item to best agent
router.post('/route', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { itemType, itemId, skill, priority } = req.body;
    const agents = await prisma.agentPresence.findMany({ where: { status: 'available' } }).catch(() => []);
    if (!agents.length) return res.json({ routed: false, reason: 'No available agents' });
    const best = agents.sort((a, b) => (a.currentLoad || 0) - (b.currentLoad || 0))[0];
    res.json({ routed: true, agentId: best.userId, itemType, itemId });
  } catch (err) { next(err); }
});

// Channel metrics
router.get('/channels/metrics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const channels = ['phone','email','chat','social','web'];
    const metrics = [];
    for (const ch of channels) {
      const count = await prisma.case.count({ where: { origin: ch, deletedAt: null, createdAt: { gte: new Date(Date.now() - 30*86400000) } } }).catch(() => 0);
      metrics.push({ channel: ch, casesLast30Days: count });
    }
    res.json(metrics);
  } catch (err) { next(err); }
});
