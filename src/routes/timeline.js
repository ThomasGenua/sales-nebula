const { Router } = require('express');
const { auditMiddleware } = require("../middleware/audit");
const { authenticate } = require('../middleware/auth');

const router = Router();
router.use(authenticate);

// GET /api/timeline/:module/:recordId - Unified activity timeline for any record
router.get('/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    const { limit = 50, before } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const cursor = before ? { createdAt: { lt: new Date(before) } } : {};

    const timeline = [];

    // Activities
    if (['contacts', 'deals', 'accounts'].includes(module)) {
      const field = module === 'contacts' ? 'contactId' : module === 'deals' ? 'dealId' : 'accountId';
      const activities = await prisma.activity.findMany({
        where: { [field]: recordId, ...cursor },
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, subject: true, type: true, status: true, dueDate: true, createdAt: true },
      });
      activities.forEach(a => timeline.push({ ...a, timelineType: 'activity', timelineDate: a.createdAt }));
    }

    // Emails
    if (['contacts', 'deals'].includes(module)) {
      const field = module === 'contacts' ? 'contactId' : 'dealId';
      const emails = await prisma.email.findMany({
        where: { [field]: recordId, ...cursor },
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, subject: true, status: true, opened: true, sentAt: true, createdAt: true },
      });
      emails.forEach(e => timeline.push({ ...e, timelineType: 'email', timelineDate: e.sentAt || e.createdAt }));
    }

    // Notes
    const notes = await prisma.note.findMany({
      where: { module, recordId, ...cursor },
      orderBy: { createdAt: 'desc' }, take,
      select: { id: true, body: true, createdAt: true },
    });
    notes.forEach(n => timeline.push({ ...n, timelineType: 'note', timelineDate: n.createdAt }));

    // Cases
    if (['contacts', 'accounts'].includes(module)) {
      const field = module === 'contacts' ? 'contactId' : 'accountId';
      const cases = await prisma.case.findMany({
        where: { [field]: recordId, ...cursor },
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, subject: true, status: true, priority: true, caseNumber: true, createdAt: true },
      });
      cases.forEach(c => timeline.push({ ...c, timelineType: 'case', timelineDate: c.createdAt }));
    }

    // Audit log entries for this record
    const audits = await prisma.auditLog.findMany({
      where: { recordId, ...cursor },
      orderBy: { createdAt: 'desc' }, take,
      // Field-level changes are written into details; there is no changes column.
      select: { id: true, action: true, module: true, details: true, createdAt: true },
    });
    audits.forEach(a => timeline.push({ ...a, timelineType: 'audit', timelineDate: a.createdAt }));

    // Deal stage history
    if (module === 'deals') {
      const stages = await prisma.dealStageHistory.findMany({
        where: { dealId: recordId, ...cursor },
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, fromStage: true, toStage: true, createdAt: true },
      });
      stages.forEach(s => timeline.push({ ...s, changedAt: s.createdAt, timelineType: 'stage_change', timelineDate: s.createdAt }));
    }

    // Chatter posts about this record. A ChatterMention names a user, not a
    // record, so the post's own recordId is what ties it here.
    const posts = await prisma.chatterPost.findMany({
      where: { recordId, ...cursor },
      orderBy: { createdAt: 'desc' }, take,
      select: { id: true, body: true, createdAt: true },
    });
    posts.forEach(p => timeline.push({ ...p, timelineType: 'chatter', timelineDate: p.createdAt }));

    // Sort all by date descending and limit
    timeline.sort((a, b) => new Date(b.timelineDate) - new Date(a.timelineDate));
    res.json({ data: timeline.slice(0, take), total: timeline.length });
  } catch (err) { next(err); }
});

module.exports = router;

// Unified timeline for a record
router.get('/record/:module/:id/unified', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, id } = req.params;
    const parentField = { contacts: 'contactId', deals: 'dealId', accounts: 'accountId', cases: 'caseId' }[module] || 'parentId';
    const [activities, notes, feedItems, emails] = await Promise.all([
      prisma.activity.findMany({ where: { [parentField]: id, deletedAt: null }, select: { id: true, subject: true, type: true, status: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []),
      prisma.note.findMany({ where: { module, recordId: id, deletedAt: null }, select: { id: true, body: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []),
      prisma.feedItem.findMany({ where: { parentId: id }, select: { id: true, body: true, type: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []),
      prisma.email.findMany({ where: { [parentField]: id, deletedAt: null }, select: { id: true, subject: true, status: true, sentAt: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []),
    ]);
    const timeline = [
      ...activities.map(a => ({ ...a, _type: 'activity', _date: a.createdAt })),
      ...notes.map(n => ({ ...n, _type: 'note', _date: n.createdAt })),
      ...feedItems.map(f => ({ ...f, _type: 'feed', _date: f.createdAt })),
      ...emails.map(e => ({ ...e, _type: 'email', _date: e.sentAt || e.createdAt })),
    ].sort((a, b) => new Date(b._date) - new Date(a._date)).slice(0, 50);
    res.json({ recordId: id, module, timeline, counts: { activities: activities.length, notes: notes.length, feed: feedItems.length, emails: emails.length } });
  } catch (err) { next(err); }
});

// Timeline stats
router.get('/stats/:module/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, id } = req.params;
    const parentField = { contacts: 'contactId', deals: 'dealId', accounts: 'accountId' }[module] || 'parentId';
    const [actCount, noteCount, emailCount, lastActivity] = await Promise.all([
      prisma.activity.count({ where: { [parentField]: id, deletedAt: null } }).catch(() => 0),
      prisma.note.count({ where: { module, recordId: id, deletedAt: null } }).catch(() => 0),
      prisma.email.count({ where: { [parentField]: id, deletedAt: null } }).catch(() => 0),
      prisma.activity.findFirst({ where: { [parentField]: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }).catch(() => null),
    ]);
    res.json({ recordId: id, activities: actCount, notes: noteCount, emails: emailCount, total: actCount + noteCount + emailCount, lastActivityAt: lastActivity?.createdAt });
  } catch (err) { next(err); }
});

// Timeline analytics
router.get('/:module/:id/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, id } = req.params;
    const events = await prisma.timelineEvent.findMany({ where: { parentModule: module, parentId: id, deletedAt: null } });
    const byType = {};
    const byMonth = {};
    events.forEach(e => {
      byType[e.type] = (byType[e.type] || 0) + 1;
      const m = new Date(e.createdAt).toISOString().substring(0, 7);
      byMonth[m] = (byMonth[m] || 0) + 1;
    });
    const firstEvent = events.length ? new Date(Math.min(...events.map(e => new Date(e.createdAt)))).toISOString() : null;
    const lastEvent = events.length ? new Date(Math.max(...events.map(e => new Date(e.createdAt)))).toISOString() : null;
    const avgPerWeek = events.length && firstEvent && lastEvent ? (events.length / Math.max(1, (new Date(lastEvent) - new Date(firstEvent)) / 604800000)).toFixed(1) : 0;
    res.json({ totalEvents: events.length, byType, byMonth, firstEvent, lastEvent, avgPerWeek: +avgPerWeek });
  } catch (err) { next(err); }
});

// Aggregate timeline across multiple records
router.get('/aggregate', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, ids, limit = 50 } = req.query;
    const where = { deletedAt: null };
    if (module) where.parentModule = module;
    if (ids) where.parentId = { in: ids.split(',') };
    const events = await prisma.timelineEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: +limit,
      select: { id: true, type: true, title: true, body: true, parentModule: true, parentId: true, createdAt: true, metadata: true } });
    res.json({ count: events.length, events });
  } catch (err) { next(err); }
});

// Bulk create timeline events
router.post('/bulk', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { events } = req.body;
    if (!events?.length) return res.status(400).json({ error: 'events array required' });
    const created = [];
    for (const ev of events.slice(0, 100)) {
      const e = await prisma.timelineEvent.create({ data: { ...ev, userId: req.user.id } });
      created.push(e);
    }
    res.status(201).json({ created: created.length, events: created });
  } catch (err) { next(err); }
});
