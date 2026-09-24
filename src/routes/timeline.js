const { Router } = require('express');
const { auditMiddleware } = require("../middleware/audit");
const { authenticate, permits } = require('../middleware/auth');
const { canReach, reachableWhere } = require('../middleware/access');
const { buildAccessFilter, applyAccessFilter } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');
const { editableFields } = require('../utils/modelFields');

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

/**
 * `where` on a related module's rows, narrowed to the live ones the caller may
 * see, or null when they may not read that module, and the section is left
 * out. Reading a record handed over its activities, emails and cases whatever
 * the caller could see of those modules.
 */
async function sectionWhere(req, module, modelName, where) {
  return permits(req, module, 'read') ? reachableWhere(req, module, modelName, where) : null;
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

    // Live rows only, as the unified and stats routes below ask: deleted
    // activities, emails, notes and cases came back here. Activities, emails
    // and cases only from modules the caller may read, and only the rows they
    // may see (sectionWhere); a section they may not read is left out.

    // Activities
    if (['contacts', 'deals', 'accounts'].includes(module)) {
      const field = module === 'contacts' ? 'contactId' : module === 'deals' ? 'dealId' : 'accountId';
      const where = await sectionWhere(req, 'activities', 'activity', { [field]: recordId, deletedAt: null, ...cursor });
      const activities = where ? await prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, subject: true, type: true, status: true, dueDate: true, createdAt: true },
      }) : [];
      activities.forEach(a => timeline.push({ ...a, timelineType: 'activity', timelineDate: a.createdAt }));
    }

    // Emails
    if (['contacts', 'deals'].includes(module)) {
      const field = module === 'contacts' ? 'contactId' : 'dealId';
      const where = await sectionWhere(req, 'emails', 'email', { [field]: recordId, deletedAt: null, ...cursor });
      const emails = where ? await prisma.email.findMany({
        where,
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, subject: true, status: true, opened: true, sentAt: true, createdAt: true },
      }) : [];
      emails.forEach(e => timeline.push({ ...e, timelineType: 'email', timelineDate: e.sentAt || e.createdAt }));
    }

    // Notes
    const notes = await prisma.note.findMany({
      where: { module, recordId, deletedAt: null, ...cursor },
      orderBy: { createdAt: 'desc' }, take,
      select: { id: true, body: true, createdAt: true },
    });
    notes.forEach(n => timeline.push({ ...n, timelineType: 'note', timelineDate: n.createdAt }));

    // Cases
    if (['contacts', 'accounts'].includes(module)) {
      const field = module === 'contacts' ? 'contactId' : 'accountId';
      const where = await sectionWhere(req, 'cases', 'case', { [field]: recordId, deletedAt: null, ...cursor });
      const cases = where ? await prisma.case.findMany({
        where,
        orderBy: { createdAt: 'desc' }, take,
        select: { id: true, subject: true, status: true, priority: true, caseNumber: true, createdAt: true },
      }) : [];
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
    // record; the post names its record as parentModule + parentId, which is
    // what POST /chatter writes. recordId, asked for alone, nothing writes,
    // so no post ever showed here.
    const posts = await prisma.chatterPost.findMany({
      where: { OR: [{ parentModule: module, parentId: recordId }, { recordModule: module, recordId }], ...cursor },
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
    // Activities and emails as the timeline above shows them (sectionWhere).
    const [activityWhere, emailWhere] = await Promise.all([
      sectionWhere(req, 'activities', 'activity', { [parentField]: id, deletedAt: null }),
      sectionWhere(req, 'emails', 'email', { [parentField]: id, deletedAt: null }),
    ]);
    const [activities, notes, feedItems, emails] = await Promise.all([
      activityWhere ? prisma.activity.findMany({ where: activityWhere, select: { id: true, subject: true, type: true, status: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []) : [],
      prisma.note.findMany({ where: { module, recordId: id, deletedAt: null }, select: { id: true, body: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []),
      prisma.feedItem.findMany({ where: { parentId: id }, select: { id: true, body: true, type: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []),
      emailWhere ? prisma.email.findMany({ where: emailWhere, select: { id: true, subject: true, status: true, sentAt: true, createdAt: true }, take: 20, orderBy: { createdAt: 'desc' } }).catch(() => []) : [],
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
    // Counted as the timeline shows them: a section the caller may not read counts nothing.
    const [activityWhere, emailWhere] = await Promise.all([
      sectionWhere(req, 'activities', 'activity', { [parentField]: id, deletedAt: null }),
      sectionWhere(req, 'emails', 'email', { [parentField]: id, deletedAt: null }),
    ]);
    const [actCount, noteCount, emailCount, lastActivity] = await Promise.all([
      activityWhere ? prisma.activity.count({ where: activityWhere }).catch(() => 0) : 0,
      prisma.note.count({ where: { module, recordId: id, deletedAt: null } }).catch(() => 0),
      emailWhere ? prisma.email.count({ where: emailWhere }).catch(() => 0) : 0,
      activityWhere ? prisma.activity.findFirst({ where: activityWhere, orderBy: { createdAt: 'desc' } }).catch(() => null) : null,
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
    const events = await prisma.timelineEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(parseInt(limit) || 50, 200),
      select: { id: true, type: true, title: true, body: true, parentModule: true, parentId: true, createdAt: true, metadata: true } });
    res.json({ count: events.length, events });
  } catch (err) { next(err); }
});

// Bulk create timeline events
// Each event of the model's own columns, less its id and timestamps, written
// by the caller, on a record they may read. The raw objects went to Prisma
// on any record id. One that fails refuses the batch before any is written,
// so a client never has to work out which of its events went in.
router.post('/bulk', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { events } = req.body;
    if (!Array.isArray(events) || !events.length) return res.status(400).json({ error: 'events array required' });
    const rows = [];
    for (const ev of events.slice(0, 100)) {
      const data = { ...editableFields('timelineEvent', ev), userId: req.user.id };
      if (!data.parentModule || !data.parentId || !data.type) return res.status(400).json({ error: 'Each event needs parentModule, parentId and type' });
      if (!(await readableRecord(req, res, data.parentModule, data.parentId))) return;
      rows.push(data);
    }
    const created = await prisma.$transaction(rows.map(data => prisma.timelineEvent.create({ data })));
    res.status(201).json({ created: created.length, events: created });
  } catch (err) { next(err); }
});
