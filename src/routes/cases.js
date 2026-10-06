const { createCrudRouter } = require('../utils/crud');
const { authenticate, requirePermission } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { CASE_NUMBER } = require('../utils/numbering');
const { fireWebhookEvent } = require('../services/webhooks');
const { updateRecord } = require('../services/recordWrites');

// A case is done once Resolved or Closed. closedAt is when it got there; it
// was never written, so the metrics' closures and CSAT and an entitlement's
// resolution times counted nothing.
const DONE = ['Resolved', 'Closed'];

const router = createCrudRouter('case', 'cases', {
  include: {
    contact: { select: { id: true, firstName: true, lastName: true } },
    account: { select: { id: true, name: true } },
    assignedTo: { select: { id: true, firstName: true, lastName: true } },
    comments: { include: { author: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' } },
    customValues: { include: { customField: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { subject: { contains: q, mode: 'insensitive' } },
      { caseNumber: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.subject?.trim()) errors.subject = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  numbering: CASE_NUMBER,
  beforeCreate: (data) => (DONE.includes(data.status) ? { ...data, closedAt: new Date() } : data),
  // A status change stamps or clears closedAt, and is recorded as escalate
  // and resolve record theirs, for the SLA's pauses: from the edit form, and
  // from a bulk or mass update, an import or the console's macros alike.
  beforeUpdate: async (data, { oldRecord }) => {
    if (data.status === undefined || oldRecord.status === data.status) return data;
    if (DONE.includes(data.status)) return { ...data, closedAt: oldRecord.closedAt || new Date() };
    return { ...data, closedAt: null };
  },
  afterUpdate: async (record, { prisma, oldRecord, userId }) => {
    if (oldRecord.status === record.status) return;
    await prisma.caseStatusHistory.create({
      data: { caseId: record.id, fromStatus: oldRecord.status, toStatus: record.status, changedById: userId },
    }).catch(() => {});
  },
  customRoutes: (router) => {
    // POST /api/cases/:id/comments
    router.post('/:id/comments', requirePermission('cases', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        // The column is "text"; callers across this repo reach for "body".
        const text = req.body.text ?? req.body.body;
        if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
        const comment = await prisma.caseComment.create({
          data: { caseId: req.params.id, text, authorId: req.userId },
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
        });
        res.status(201).json(comment);
      } catch (err) { next(err); }
    });

    // POST /api/cases/:id/escalate
    // It also flags the case as escalated, when and why, as the SLA job does.
    // A second escalate route further down set those and was never reached,
    // so a case escalated here still reported isEscalated false.
    router.post('/:id/escalate', requirePermission('cases', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const cs = await prisma.case.findFirst({ where: { id: req.params.id, deletedAt: null } });
        if (!cs) return res.status(404).json({ error: 'Not found' });

        // As an edit (services/recordWrites): the case's rules, its status
        // history (the module's hook keeps it, for the SLA's pause windows),
        // the audit trail, and the workflows on a status change, which an
        // escalation never reached.
        const { record: updated } = await updateRecord(prisma, 'cases', cs, {
          status: 'Escalated',
          priority: cs.priority === 'Low' ? 'Medium' : cs.priority === 'Medium' ? 'High' : 'Critical',
          isEscalated: true, escalatedAt: new Date(), escalationReason: req.body.reason || null,
          ...(req.body.assignedId && { assignedId: req.body.assignedId }),
        }, {
          req, userId: req.userId, source: 'escalated',
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            assignedTo: { select: { id: true, firstName: true, lastName: true } },
          },
        });

        await prisma.caseComment.create({
          data: {
            caseId: req.params.id,
            text: `Case escalated${req.body.reason ? ': ' + req.body.reason : ''}`,
            authorId: req.userId,
          },
        });

        await fireWebhookEvent(prisma, 'case.escalated', { id: cs.id, caseNumber: cs.caseNumber });
        res.json(updated);
      } catch (err) { next(err); }
    });

    // POST /api/cases/:id/resolve
    router.post('/:id/resolve', requirePermission('cases', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        // As an edit: the module's hook stamps closedAt and keeps the status
        // history, and the case's rules and workflows see it resolved.
        const { record: updated } = await updateRecord(prisma, 'cases', req.params.id, {
          status: 'Resolved', resolution: req.body.resolution || '',
        }, { req, userId: req.userId, source: 'resolved', include: { contact: { select: { id: true, firstName: true, lastName: true } } } });

        await fireWebhookEvent(prisma, 'case.resolved', { id: updated.id, caseNumber: updated.caseNumber });
        res.json(updated);
      } catch (err) { next(err); }
    });

    // GET /api/cases/stats/overview
    router.get('/stats/overview', requirePermission('cases', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        // The live cases the caller may see; this counted every case, deleted included.
        const cases = await prisma.case.findMany({ where: await reachableWhere(req, 'cases', 'case'), select: { status: true, priority: true, type: true, createdAt: true } });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const thisMonth = cases.filter(c => c.createdAt >= startOfMonth);

        const byStatus = {};
        const byPriority = {};
        const byType = {};
        cases.forEach(c => {
          byStatus[c.status] = (byStatus[c.status] || 0) + 1;
          byPriority[c.priority] = (byPriority[c.priority] || 0) + 1;
          byType[c.type] = (byType[c.type] || 0) + 1;
        });

        const open = cases.filter(c => !['Resolved', 'Closed'].includes(c.status));
        const resolved = cases.filter(c => c.status === 'Resolved' || c.status === 'Closed');

        res.json({
          total: cases.length,
          open: open.length,
          resolved: resolved.length,
          newThisMonth: thisMonth.length,
          resolutionRate: cases.length > 0 ? Math.round(resolved.length / cases.length * 100) : 0,
          byStatus,
          byPriority,
          byType,
        });
      } catch (err) { next(err); }
    });
  },
});

// SLA status for case
router.get('/:id/sla', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const cs = await prisma.case.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!cs) return res.status(404).json({ error: 'Not found' });
    // The active policy for the case's priority, whose targets are minutes.
    // This took any active policy and read hour columns it does not have, so
    // every case got 4h and 24h; and it read firstResponseAt and resolvedAt,
    // which a case does not have, so a closed case still counted as breaching.
    const policy = await prisma.slaPolicy.findFirst({ where: { active: true, priority: cs.priority }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    const now = new Date();
    const created = new Date(cs.createdAt);
    const ageHours = (now - created) / 3600000;
    const responseTarget = policy ? policy.firstResponseMinutes / 60 : 4;
    const resolveTarget = policy ? policy.resolutionMinutes / 60 : 24;
    const done = DONE.includes(cs.status);
    const resolvedAt = done ? (cs.closedAt || cs.updatedAt) : null;
    const resolvedHours = resolvedAt ? (new Date(resolvedAt) - created) / 3600000 : null;
    res.json({
      caseId: cs.id, priority: cs.priority, status: cs.status,
      // No reply time is recorded; as the SLA job judges it, a case breaches
      // first response by staying open past the target.
      firstResponse: { targetHours: responseTarget, breached: cs.slaBreached || (!done && ageHours > responseTarget) },
      resolution: { targetHours: resolveTarget, resolvedAt, breached: done ? resolvedHours > resolveTarget : ageHours > resolveTarget },
      ageHours: Math.round(ageHours), isEscalated: cs.isEscalated || false,
    });
  } catch (err) { next(err); }
});

// Case satisfaction survey
router.post('/:id/satisfaction', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 required' });
    await updateRecord(prisma, 'cases', req.params.id, { satisfactionRating: +rating, satisfactionComment: comment }, { req, userId: req.userId, source: 'satisfaction' });
    res.json({ message: 'Thank you for your feedback', rating: +rating });
  } catch (err) { next(err); }
});

// Case metrics
router.get('/metrics/overview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A number of days; anything else made an invalid date and a 500.
    const period = parseInt(req.query.period) || 30;
    const since = new Date(Date.now() - period * 86400000);
    // Over the live cases the caller may see; this counted everyone's. Open
    // is every case not yet done (escalated ones were left out), and closed
    // is those done in the period, now that closedAt is written.
    const visible = where => reachableWhere(req, 'cases', 'case', where);
    const [total, open, closed, byPriority, avgSatisfaction] = await Promise.all([
      prisma.case.count({ where: await visible({ createdAt: { gte: since } }) }),
      prisma.case.count({ where: await visible({ status: { notIn: DONE } }) }),
      prisma.case.count({ where: await visible({ status: { in: DONE }, closedAt: { gte: since } }) }),
      prisma.case.groupBy({ by: ['priority'], where: await visible({ createdAt: { gte: since } }), _count: true }),
      prisma.case.aggregate({ where: await visible({ satisfactionRating: { not: null }, closedAt: { gte: since } }), _avg: { satisfactionRating: true } }),
    ]);
    res.json({ period, total, open, closed, closureRate: total ? Math.round(closed / total * 100) : 0, avgCSAT: avgSatisfaction._avg.satisfactionRating ? avgSatisfaction._avg.satisfactionRating.toFixed(1) : null, byPriority: byPriority.map(p => ({ priority: p.priority, count: p._count })) });
  } catch (err) { next(err); }
});

module.exports = router;
