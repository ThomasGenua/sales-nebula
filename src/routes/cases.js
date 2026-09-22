const { createCrudRouter } = require('../utils/crud');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { CASE_NUMBER } = require('../utils/numbering');

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
  customRoutes: (router) => {
    // POST /api/cases/:id/comments
    router.post('/:id/comments', requirePermission('cases', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const comment = await prisma.caseComment.create({
          // The column is "text"; callers across this repo reach for "body".
          data: { caseId: req.params.id, text: req.body.text ?? req.body.body, authorId: req.userId },
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
        });
        res.status(201).json(comment);
      } catch (err) { next(err); }
    });

    // POST /api/cases/:id/escalate
    router.post('/:id/escalate', requirePermission('cases', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const cs = await prisma.case.findUnique({ where: { id: req.params.id } });
        if (!cs) return res.status(404).json({ error: 'Not found' });

        const updated = await prisma.case.update({
          where: { id: req.params.id },
          data: {
            status: 'Escalated',
            priority: cs.priority === 'Low' ? 'Medium' : cs.priority === 'Medium' ? 'High' : 'Critical',
            ...(req.body.assignedId && { assignedId: req.body.assignedId }),
          },
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

        // Record the transition so SLA pause windows can be reconstructed
        await prisma.caseStatusHistory.create({
          data: { caseId: cs.id, fromStatus: cs.status, toStatus: 'Escalated', changedById: req.userId },
        }).catch(() => {});

        await req.audit({ action: 'update', module: 'cases', recordId: cs.id, details: `Escalated case ${cs.caseNumber}` });
        res.json(updated);
      } catch (err) { next(err); }
    });

    // POST /api/cases/:id/resolve
    router.post('/:id/resolve', requirePermission('cases', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const prior = await prisma.case.findUnique({ where: { id: req.params.id }, select: { status: true } });
        const updated = await prisma.case.update({
          where: { id: req.params.id },
          data: { status: 'Resolved', resolution: req.body.resolution || '' },
          include: { contact: { select: { id: true, firstName: true, lastName: true } } },
        });

        await prisma.caseStatusHistory.create({
          data: { caseId: updated.id, fromStatus: prior?.status || null, toStatus: 'Resolved', changedById: req.userId },
        }).catch(() => {});
        await req.audit({ action: 'update', module: 'cases', recordId: updated.id, details: `Resolved case ${updated.caseNumber}` });
        res.json(updated);
      } catch (err) { next(err); }
    });

    // GET /api/cases/stats/overview
    router.get('/stats/overview', requirePermission('cases', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const cases = await prisma.case.findMany({ select: { status: true, priority: true, type: true, createdAt: true } });
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
    const cs = await prisma.case.findUnique({ where: { id: req.params.id } });
    if (!cs) return res.status(404).json({ error: 'Not found' });
    const policy = await prisma.slaPolicy.findFirst({ where: { active: true } }).catch(() => null);
    const now = new Date();
    const created = new Date(cs.createdAt);
    const ageHours = (now - created) / 3600000;
    const responseTarget = policy?.firstResponseHours || 4;
    const resolveTarget = policy?.resolutionHours || 24;
    res.json({
      caseId: cs.id, priority: cs.priority, status: cs.status,
      firstResponse: { targetHours: responseTarget, respondedAt: cs.firstResponseAt, breached: !cs.firstResponseAt && ageHours > responseTarget },
      resolution: { targetHours: resolveTarget, resolvedAt: cs.resolvedAt, breached: !cs.resolvedAt && ageHours > resolveTarget },
      ageHours: Math.round(ageHours), isEscalated: cs.isEscalated || false,
    });
  } catch (err) { next(err); }
});

// Escalate case
router.post('/:id/escalate', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { reason, escalateToId } = req.body;
    const updated = await prisma.case.update({
      where: { id: req.params.id },
      data: { isEscalated: true, escalatedAt: new Date(), escalationReason: reason, status: 'Escalated', ...(escalateToId && { ownerId: escalateToId }) },
    });
    await req.audit({ action: 'update', module: 'cases', recordId: updated.id, details: `Escalated: ${reason || 'No reason'}` });
    res.json(updated);
  } catch (err) { next(err); }
});

// Case satisfaction survey
router.post('/:id/satisfaction', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 required' });
    const updated = await prisma.case.update({ where: { id: req.params.id }, data: { satisfactionRating: +rating, satisfactionComment: comment } });
    res.json({ message: 'Thank you for your feedback', rating: +rating });
  } catch (err) { next(err); }
});

// Case metrics
router.get('/metrics/overview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period = '30' } = req.query;
    const since = new Date(Date.now() - (+period) * 86400000);
    const [total, open, closed, byPriority, avgSatisfaction] = await Promise.all([
      prisma.case.count({ where: { createdAt: { gte: since }, deletedAt: null } }),
      prisma.case.count({ where: { status: { in: ['New','Open','Pending'] }, deletedAt: null } }),
      prisma.case.count({ where: { status: 'Closed', closedAt: { gte: since }, deletedAt: null } }),
      prisma.case.groupBy({ by: ['priority'], where: { createdAt: { gte: since }, deletedAt: null }, _count: true }),
      prisma.case.aggregate({ where: { satisfactionRating: { not: null }, closedAt: { gte: since } }, _avg: { satisfactionRating: true } }),
    ]);
    res.json({ period: +period, total, open, closed, closureRate: total ? Math.round(closed / total * 100) : 0, avgCSAT: avgSatisfaction._avg.satisfactionRating ? avgSatisfaction._avg.satisfactionRating.toFixed(1) : null, byPriority: byPriority.map(p => ({ priority: p.priority, count: p._count })) });
  } catch (err) { next(err); }
});

module.exports = router;
