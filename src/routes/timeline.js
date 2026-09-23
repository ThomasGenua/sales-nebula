const { Router } = require('express');
const { auditMiddleware } = require("../middleware/audit");
const { authenticate, permits } = require('../middleware/auth');
const { canReach } = require('../middleware/access');
const { buildAccessFilter, applyAccessFilter } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');

const router = Router();
router.use(authenticate);

/**
 * Whether the caller may read a record's history: the module's read
 * permission, and a record they can see. Otherwise answers and returns false.
 * These took any record id with authenticate() alone, so anyone read any
 * record's activities, emails, notes, cases, audit log and chatter.
 */
async function readableRecord(req, res, module, id) {
  const modelName = crudModelFor(module);
  if (!modelName) { res.status(400).json({ error: `No timeline for ${module}` }); return false; }
  if (!permits(req, module, 'read')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return false; }
  // canReach passes any id in a module nothing restricts, and the audit log,
  // chatter and feed match on the id alone, so the id must be this module's.
  const exists = await req.app.locals.prisma[modelName].findFirst({ where: { id: String(id) }, select: { id: true } });
  if (!exists || !(await canReach(req, module, modelName, id))) { res.status(404).json({ error: 'Not found' }); return false; }
  return true;
}

// GET /api/timeline/:module/:recordId - Unified activity timeline for any record
router.get('/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    if (!(await readableRecord(req, res, module, recordId))) return;
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
    if (!(await readableRecord(req, res, module, id))) return;
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
    if (!(await readableRecord(req, res, module, id))) return;
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
    if (!(await readableRecord(req, res, module, id))) return;
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
    // This returned every record's events, in every module, to anyone signed
    // in. Now: one module the caller may read, and only records they can see.
    const modelName = crudModelFor(module);
    if (!modelName) return res.status(400).json({ error: 'module must name a record module' });
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const where = { deletedAt: null, parentModule: module };
    const requested = ids ? { id: { in: ids.split(',') } } : {};
    const filter = await buildAccessFilter(prisma, req.user, module, { modelName });
    if (filter) {
      const visible = await prisma[modelName].findMany({ where: applyAccessFilter(requested, filter), select: { id: true } });
      where.parentId = { in: visible.map(r => r.id) };
    } else if (ids) {
      where.parentId = requested.id;
    }
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
