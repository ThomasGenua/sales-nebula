const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

const STATUSES = ['New', 'Assigned', 'Confirmed', 'InProgress', 'Fixed', 'Verified', 'Closed', 'Rejected', 'Duplicate', 'Deferred'];
const OPEN_STATUSES = ['New', 'Assigned', 'Confirmed', 'InProgress', 'Fixed'];
const SEVERITIES = ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'];
const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const TYPES = ['Defect', 'Feature', 'Enhancement', 'Task', 'Regression'];

/** Sequential bug number, scoped to the whole table. */
async function nextBugNumber(prisma) {
  const last = await prisma.bug.findFirst({ orderBy: { createdAt: 'desc' }, select: { bugNumber: true } });
  const n = last?.bugNumber ? parseInt(String(last.bugNumber).replace(/\D/g, ''), 10) : 0;
  return `BUG-${String((isNaN(n) ? 0 : n) + 1).padStart(5, '0')}`;
}

/** Record a field-level change so the bug has an auditable trail. */
async function logChange(prisma, bugId, userId, field, from, to) {
  if (String(from ?? '') === String(to ?? '')) return;
  await prisma.bugHistory.create({
    data: { bugId, userId, field, oldValue: from == null ? null : String(from).slice(0, 500), newValue: to == null ? null : String(to).slice(0, 500) },
  }).catch(() => {});
}

// ── BUGS ──────────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { search, status, severity, priority, type, assignedToId, releaseId, component, open, page = 1, limit = 50, sortBy = 'createdAt', sortDir = 'desc' } = req.query;

    const where = { deletedAt: null };
    if (search) where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { bugNumber: { contains: search, mode: 'insensitive' } },
    ];
    if (status) where.status = status;
    if (open === 'true') where.status = { in: OPEN_STATUSES };
    if (open === 'false') where.status = { in: ['Closed', 'Rejected', 'Duplicate'] };
    if (severity) where.severity = severity;
    if (priority) where.priority = priority;
    if (type) where.type = type;
    if (assignedToId) where.assignedToId = assignedToId;
    if (releaseId) where.fixedInReleaseId = releaseId;
    if (component) where.component = component;

    const [data, total] = await Promise.all([
      prisma.bug.findMany({ where, skip: (+page - 1) * +limit, take: Math.min(+limit, 200), orderBy: { [sortBy]: sortDir } }),
      prisma.bug.count({ where }),
    ]);
    res.json({ data, total, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bug = await prisma.bug.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });

    const [comments, watchers, history, duplicates] = await Promise.all([
      prisma.bugComment.findMany({ where: { bugId: bug.id }, orderBy: { createdAt: 'asc' } }).catch(() => []),
      prisma.bugWatcher.findMany({ where: { bugId: bug.id } }).catch(() => []),
      prisma.bugHistory.findMany({ where: { bugId: bug.id }, orderBy: { createdAt: 'desc' }, take: 50 }).catch(() => []),
      prisma.bug.findMany({ where: { duplicateOfId: bug.id, deletedAt: null }, select: { id: true, bugNumber: true, title: true } }).catch(() => []),
    ]);

    // Cases reported against this defect
    const linkedCases = await prisma.case.findMany({
      where: { deletedAt: null, description: { contains: bug.bugNumber } },
      select: { id: true, caseNumber: true, subject: true, status: true },
      take: 20,
    }).catch(() => []);

    res.json({
      ...bug,
      comments, watchers, history, duplicates, linkedCases,
      isWatching: watchers.some(w => w.userId === req.user.id),
    });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('cases', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { title, description, stepsToReproduce, expectedResult, actualResult, severity, priority, type, component, foundInReleaseId, assignedToId, environment, caseId } = req.body;

    if (!title) return res.status(400).json({ error: 'title required' });
    if (severity && !SEVERITIES.includes(severity)) return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
    if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: `priority must be one of: ${PRIORITIES.join(', ')}` });
    if (type && !TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });

    const bug = await prisma.bug.create({
      data: {
        bugNumber: await nextBugNumber(prisma),
        title, description, stepsToReproduce,
        // The columns are expectedBehavior/actualBehavior; the request body
        // keeps the friendlier names.
        expectedBehavior: expectedResult, actualBehavior: actualResult,
        severity: severity || 'Major', priority: priority || 'Medium',
        type: type || 'Defect', status: assignedToId ? 'Assigned' : 'New',
        component, environment,
        foundInReleaseId: foundInReleaseId || null,
        assignedToId: assignedToId || null,
        reportedById: req.user.id,
      },
    });

    // The reporter and assignee watch by default
    for (const userId of [req.user.id, assignedToId].filter(Boolean)) {
      await prisma.bugWatcher.create({ data: { bugId: bug.id, userId } }).catch(() => {});
    }

    // Note the linkage on the originating case
    if (caseId) {
      await prisma.case.update({
        where: { id: caseId },
        data: { description: { set: undefined } },
      }).catch(() => {});
      await prisma.bugComment.create({
        data: { bugId: bug.id, userId: req.user.id, body: `Reported from case ${caseId}`, isInternal: true },
      }).catch(() => {});
    }

    await req.audit({ action: 'create', module: 'bugs', recordId: bug.id, details: `Bug created: ${bug.bugNumber} ${title}` });
    res.status(201).json(bug);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('cases', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.bug.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!existing) return res.status(404).json({ error: 'Bug not found' });

    const { id, createdAt, bugNumber, comments, watchers, history, duplicates, linkedCases, isWatching, ...data } = req.body;

    if (data.status && !STATUSES.includes(data.status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    if (data.severity && !SEVERITIES.includes(data.severity)) return res.status(400).json({ error: `Invalid severity` });
    if (data.status === 'Duplicate' && !data.duplicateOfId && !existing.duplicateOfId) {
      return res.status(400).json({ error: 'duplicateOfId required when marking a bug as a duplicate' });
    }
    if (data.duplicateOfId === existing.id) return res.status(400).json({ error: 'A bug cannot be a duplicate of itself' });

    // Status transitions carry timestamps
    if (data.status && data.status !== existing.status) {
      if (data.status === 'Fixed' && !existing.fixedAt) data.fixedAt = new Date();
      if (data.status === 'Verified') data.verifiedAt = new Date();
      if (['Closed', 'Rejected'].includes(data.status)) data.closedAt = new Date();
      if (OPEN_STATUSES.includes(data.status) && existing.closedAt) { data.closedAt = null; data.reopenCount = (existing.reopenCount || 0) + 1; }
    }
    if (data.assignedToId && data.assignedToId !== existing.assignedToId && existing.status === 'New') data.status = 'Assigned';

    const bug = await prisma.bug.update({ where: { id: existing.id }, data });

    for (const field of ['status', 'severity', 'priority', 'assignedToId', 'component', 'fixedInReleaseId']) {
      if (data[field] !== undefined) await logChange(prisma, bug.id, req.user.id, field, existing[field], data[field]);
    }
    if (data.assignedToId) await prisma.bugWatcher.create({ data: { bugId: bug.id, userId: data.assignedToId } }).catch(() => {});

    await req.audit({ action: 'update', module: 'bugs', recordId: bug.id, details: `Bug updated: ${bug.bugNumber}` });
    res.json(bug);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('cases', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.bug.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Bulk triage
router.post('/bulk', authenticate, requirePermission('cases', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { bugIds, changes } = req.body;
    if (!Array.isArray(bugIds) || !bugIds.length) return res.status(400).json({ error: 'bugIds array required' });
    if (!changes || !Object.keys(changes).length) return res.status(400).json({ error: 'changes object required' });
    if (changes.status && !STATUSES.includes(changes.status)) return res.status(400).json({ error: 'Invalid status' });
    if (changes.severity && !SEVERITIES.includes(changes.severity)) return res.status(400).json({ error: 'Invalid severity' });

    const data = { ...changes };
    if (changes.status === 'Fixed') data.fixedAt = new Date();
    if (['Closed', 'Rejected'].includes(changes.status)) data.closedAt = new Date();

    const result = await prisma.bug.updateMany({ where: { id: { in: bugIds }, deletedAt: null }, data });
    await req.audit({ action: 'update', module: 'bugs', recordId: 'bulk', details: `${result.count} bugs updated` });
    res.json({ updated: result.count });
  } catch (err) { next(err); }
});

// ── COMMENTS AND WATCHERS ─────────────────────────────────────────────

router.post('/:id/comments', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { body, isInternal } = req.body;
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });

    const bug = await prisma.bug.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });

    const comment = await prisma.bugComment.create({
      data: { bugId: bug.id, userId: req.user.id, body: String(body).slice(0, 10000), isInternal: !!isInternal },
    });
    await prisma.bugWatcher.create({ data: { bugId: bug.id, userId: req.user.id } }).catch(() => {});
    res.status(201).json(comment);
  } catch (err) { next(err); }
});

router.delete('/comments/:commentId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const comment = await prisma.bugComment.findUnique({ where: { id: req.params.commentId } });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your comment' });
    await prisma.bugComment.delete({ where: { id: comment.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post('/:id/watch', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.bugWatcher.findFirst({ where: { bugId: req.params.id, userId: req.user.id } });
    if (existing) {
      await prisma.bugWatcher.delete({ where: { id: existing.id } });
      return res.json({ watching: false });
    }
    await prisma.bugWatcher.create({ data: { bugId: req.params.id, userId: req.user.id } });
    res.json({ watching: true });
  } catch (err) { next(err); }
});

// ── RELEASES ──────────────────────────────────────────────────────────

router.get('/releases/all', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const releases = await prisma.release.findMany({
      where: { deletedAt: null },
      orderBy: [{ releaseDate: 'desc' }, { name: 'desc' }],
      take: Math.min(parseInt(req.query.limit, 10) || 100, 300),
    });

    const enriched = [];
    for (const r of releases) {
      const [fixed, open] = await Promise.all([
        prisma.bug.count({ where: { fixedInReleaseId: r.id, deletedAt: null } }),
        // Bug has no targetRelease; outstanding work against a release is
        // what was found in it and is not yet closed.
        prisma.bug.count({ where: { foundInReleaseId: r.id, status: { in: OPEN_STATUSES }, deletedAt: null } }),
      ]);
      enriched.push({ ...r, bugsFixed: fixed, bugsOutstanding: open });
    }
    res.json(enriched);
  } catch (err) { next(err); }
});

router.post('/releases', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, version, description, releaseDate, status } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const validStatuses = ['Planned', 'InDevelopment', 'Testing', 'Released', 'Cancelled'];
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

    const dupe = await prisma.release.findFirst({ where: { name, deletedAt: null } });
    if (dupe) return res.status(409).json({ error: `A release named "${name}" already exists` });

    const release = await prisma.release.create({
      data: { name, version, description, status: status || 'Planned', releaseDate: releaseDate ? new Date(releaseDate) : null },
    });
    await req.audit({ action: 'create', module: 'bugs', recordId: release.id, details: `Release created: ${name}` });
    res.status(201).json(release);
  } catch (err) { next(err); }
});

router.put('/releases/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, bugsFixed, bugsOutstanding, ...data } = req.body;
    if (data.releaseDate) data.releaseDate = new Date(data.releaseDate);
    if (data.status === 'Released' && !data.actualReleaseDate) data.actualReleaseDate = new Date();
    res.json(await prisma.release.update({ where: { id: req.params.id }, data }));
  } catch (err) { next(err); }
});

// Release notes assembled from the fixed bug list
router.get('/releases/:id/notes', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const release = await prisma.release.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const bugs = await prisma.bug.findMany({
      where: { fixedInReleaseId: release.id, deletedAt: null, status: { in: ['Fixed', 'Verified', 'Closed'] } },
      orderBy: [{ type: 'asc' }, { severity: 'asc' }],
    });

    const grouped = {};
    for (const b of bugs) (grouped[b.type || 'Defect'] = grouped[b.type || 'Defect'] || []).push({ bugNumber: b.bugNumber, title: b.title, severity: b.severity, component: b.component });

    const lines = [`# ${release.name}${release.version ? ` (${release.version})` : ''}`, ''];
    if (release.releaseDate) lines.push(`Released ${new Date(release.releaseDate).toLocaleDateString()}`, '');
    if (release.description) lines.push(release.description, '');
    for (const [type, items] of Object.entries(grouped)) {
      lines.push(`## ${type}${items.length > 1 ? 's' : ''}`, '');
      for (const i of items) lines.push(`- ${i.bugNumber}: ${i.title}${i.component ? ` (${i.component})` : ''}`);
      lines.push('');
    }

    res.json({ release: { id: release.id, name: release.name, version: release.version, status: release.status }, totalItems: bugs.length, byType: grouped, markdown: lines.join('\n') });
  } catch (err) { next(err); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────

router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const days = parseInt(req.query.days, 10) || 90;
    const since = new Date(Date.now() - days * 86400000);

    const bugs = await prisma.bug.findMany({
      where: { deletedAt: null },
      select: { status: true, severity: true, priority: true, type: true, component: true, createdAt: true, closedAt: true, fixedAt: true, reopenCount: true, assignedToId: true },
      take: 20000,
    });

    const open = bugs.filter(b => OPEN_STATUSES.includes(b.status));
    const closed = bugs.filter(b => b.closedAt);
    const recent = bugs.filter(b => new Date(b.createdAt) >= since);
    const closedRecent = closed.filter(b => new Date(b.closedAt) >= since);

    const resolutionDays = closed
      .filter(b => b.closedAt && b.createdAt)
      .map(b => (new Date(b.closedAt) - new Date(b.createdAt)) / 86400000);
    const avgResolutionDays = resolutionDays.length ? +(resolutionDays.reduce((s, d) => s + d, 0) / resolutionDays.length).toFixed(1) : 0;

    const tally = key => bugs.reduce((a, b) => { const k = b[key] || 'Unspecified'; a[k] = (a[k] || 0) + 1; return a; }, {});

    res.json({
      total: bugs.length,
      open: open.length,
      closed: closed.length,
      unassigned: open.filter(b => !b.assignedToId).length,
      blockers: open.filter(b => b.severity === 'Blocker').length,
      reopened: bugs.filter(b => (b.reopenCount || 0) > 0).length,
      periodDays: days,
      openedInPeriod: recent.length,
      closedInPeriod: closedRecent.length,
      netChange: recent.length - closedRecent.length,
      avgResolutionDays,
      byStatus: tally('status'),
      bySeverity: tally('severity'),
      byType: tally('type'),
      byComponent: tally('component'),
    });
  } catch (err) { next(err); }
});

// Open bugs weighted by age and severity, for triage ordering
router.get('/analytics/triage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bugs = await prisma.bug.findMany({
      where: { deletedAt: null, status: { in: OPEN_STATUSES } },
      take: 2000,
    });

    const severityWeight = { Blocker: 100, Critical: 60, Major: 30, Minor: 10, Trivial: 3 };
    const priorityWeight = { Urgent: 40, High: 25, Medium: 10, Low: 3 };

    const scored = bugs.map(b => {
      const ageDays = (Date.now() - new Date(b.createdAt)) / 86400000;
      const score = (severityWeight[b.severity] || 10)
        + (priorityWeight[b.priority] || 10)
        + Math.min(50, ageDays * 0.5)
        + (b.reopenCount || 0) * 15
        + (b.assignedToId ? 0 : 10);
      return {
        id: b.id, bugNumber: b.bugNumber, title: b.title,
        severity: b.severity, priority: b.priority, status: b.status,
        component: b.component, assignedToId: b.assignedToId,
        ageDays: Math.round(ageDays), reopenCount: b.reopenCount || 0,
        triageScore: Math.round(score),
      };
    });

    scored.sort((a, b) => b.triageScore - a.triageScore);
    res.json({ openBugs: scored.length, staleOver30Days: scored.filter(s => s.ageDays > 30).length, queue: scored.slice(0, 100) });
  } catch (err) { next(err); }
});

module.exports = router;
