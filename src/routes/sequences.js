const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach, reachableWhere } = require('../middleware/access');
const { columnsFrom, scalarOrderBy } = require('../utils/modelFields');
const { processDueSteps } = require('../services/sequenceSteps');

const router = Router();
router.use(authenticate, auditMiddleware);

// An enrollment keeps contactId and leadId as plain columns, which
// linkRefusal cannot check, so the routes below check them themselves.
const PEOPLE = { contactId: ['contacts', 'contact'], leadId: ['leads', 'lead'] };

/** Why the caller may not enroll the people `ids` name under `key`, or null. */
async function enrollRefusal(req, key, ids) {
  if (!ids.length) return null;
  const [module, model] = PEOPLE[key];
  const found = permits(req, module, 'read') ? await req.app.locals.prisma[model].findMany({
    where: await reachableWhere(req, module, model, { id: { in: ids.map(String) } }),
    select: { id: true },
  }) : [];
  const visible = new Set(found.map(r => r.id));
  return ids.every(id => visible.has(String(id))) ? null : `${key} does not name a ${model} you can see`;
}

/** Whether the caller may see the person `id` names; sends the 403 or 404 itself when not. */
async function mayReachPerson(req, res, key, id) {
  const [module, model] = PEOPLE[key];
  if (!permits(req, module, 'read')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return false; }
  if (!(await canReach(req, module, model, id))) { res.status(404).json({ error: 'Not found' }); return false; }
  return true;
}

const STATUSES = ['Draft', 'Active', 'Paused', 'Archived'];

/** A sequence's steps as a list, however they were stored. */
function stepsOf(sequence) {
  let steps = sequence.steps;
  if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch { steps = []; } }
  return Array.isArray(steps) ? steps : [];
}

// LIST sequences
// Filtered, searched and paged, with the total and the step and enrollment
// counts the list screen shows: it returned every sequence, unfiltered and
// uncounted, and neither count under the name the screen reads.
router.get('/', requirePermission('emails', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, search, page = 1, limit = 50, sortBy, sortDir } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const current = Math.max(parseInt(page) || 1, 1);
    const where = {};
    if (status && status !== 'All') where.status = status;
    if (search) where.name = { contains: search, mode: 'insensitive' };
    const [sequences, total] = await Promise.all([
      prisma.emailSequence.findMany({
        where,
        orderBy: scalarOrderBy('emailSequence', sortBy, sortDir) || { updatedAt: 'desc' },
        skip: (current - 1) * take, take,
        include: { _count: { select: { enrollments: true } } },
      }),
      prisma.emailSequence.count({ where }),
    ]);
    res.json({
      data: sequences.map(s => ({ ...s, enrollmentCount: s._count.enrollments, enrolledCount: s._count.enrollments, totalSteps: stepsOf(s).length })),
      total, page: current, pages: Math.ceil(total / take),
    });
  } catch (err) { next(err); }
});

// GET one
router.get('/:id', requirePermission('emails', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sequence = await prisma.emailSequence.findUnique({
      where: { id: req.params.id },
      include: {
        enrollments: {
          orderBy: { enrolledAt: 'desc' },
          take: 50,
        },
        _count: { select: { enrollments: true } },
      },
    });
    if (!sequence) return res.status(404).json({ error: 'Not found' });

    // Enrollment stats, over every enrollment: they were counted from the 50
    // loaded above, beside a total of all of them.
    const byStatus = await prisma.emailSequenceEnrollment.groupBy({ by: ['status'], where: { sequenceId: sequence.id }, _count: true });
    const inStatus = status => byStatus.find(g => g.status === status)?._count || 0;

    res.json({
      ...sequence, enrolledCount: sequence._count.enrollments, totalSteps: stepsOf(sequence).length,
      stats: { total: sequence._count.enrollments, active: inStatus('Active'), completed: inStatus('Completed'), optedOut: inStatus('Opted Out') },
    });
  } catch (err) { next(err); }
});

// CREATE
router.post('/', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description } = req.body;
    const steps = req.body.steps ?? [];
    const status = req.body.status || 'Draft';
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    // A draft may be saved before its steps are written; only an active
    // sequence needs one. Every create required steps, which the Sequences
    // screen has no field for, so it could not create a sequence at all.
    if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps must be an array' });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    if (status === 'Active' && !steps.length) return res.status(400).json({ error: 'At least one step required' });

    const sequence = await prisma.emailSequence.create({
      data: { name, description, steps, status, createdById: req.userId },
    });
    await req.audit({ action: 'create', module: 'emails', recordId: sequence.id, details: `Created email sequence: ${name}` });
    res.status(201).json(sequence);
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.emailSequence.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const data = columnsFrom('emailSequence', req.body);
    // As on create: a known status, and steps before it is active.
    if (data.steps !== undefined && !Array.isArray(data.steps)) return res.status(400).json({ error: 'steps must be an array' });
    if (data.status !== undefined && !STATUSES.includes(data.status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    if ((data.status ?? current.status) === 'Active' && !(data.steps ?? stepsOf(current)).length) {
      return res.status(400).json({ error: 'At least one step required' });
    }
    const sequence = await prisma.emailSequence.update({ where: { id: current.id }, data });
    res.json(sequence);
  } catch (err) { next(err); }
});

// DELETE
router.delete('/:id', requirePermission('emails', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.emailSequence.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/activate
router.post('/:id/activate', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.emailSequence.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    if (!stepsOf(current).length) return res.status(400).json({ error: 'At least one step required' });
    const sequence = await prisma.emailSequence.update({
      where: { id: req.params.id },
      data: { status: 'Active' },
    });
    res.json(sequence);
  } catch (err) { next(err); }
});

// POST /:id/pause
router.post('/:id/pause', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sequence = await prisma.emailSequence.update({
      where: { id: req.params.id },
      data: { status: 'Paused' },
    });
    res.json(sequence);
  } catch (err) { next(err); }
});

// POST /:id/enroll - Enroll contacts/leads in sequence
router.post('/:id/enroll', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactIds = [], leadIds = [] } = req.body;
    if (!Array.isArray(contactIds) || !Array.isArray(leadIds) || (contactIds.length === 0 && leadIds.length === 0)) {
      return res.status(400).json({ error: 'At least one contactId or leadId required' });
    }

    const sequence = await prisma.emailSequence.findUnique({ where: { id: req.params.id } });
    if (!sequence) return res.status(404).json({ error: 'Not found' });
    if (sequence.status !== 'Active') return res.status(400).json({ error: 'Sequence must be active to enroll' });

    // Only live people the caller can see, checked before any is enrolled.
    // The ids were enrolled as sent, so a sequence would email contacts and
    // leads hidden from the caller.
    const refusal = await enrollRefusal(req, 'contactId', contactIds) || await enrollRefusal(req, 'leadId', leadIds);
    if (refusal) return res.status(400).json({ error: refusal, code: 'LINK_NOT_VISIBLE' });

    const steps = stepsOf(sequence);
    const firstDelay = steps[0]?.delayDays || 0;
    const nextSendAt = new Date(Date.now() + firstDelay * 86400000);

    const enrollments = [];
    for (const contactId of contactIds) {
      // Check if already enrolled
      const existing = await prisma.emailSequenceEnrollment.findFirst({
        where: { sequenceId: req.params.id, contactId, status: 'Active' },
      });
      if (!existing) {
        enrollments.push({ sequenceId: req.params.id, contactId, enrolledById: req.userId, nextSendAt });
      }
    }
    for (const leadId of leadIds) {
      const existing = await prisma.emailSequenceEnrollment.findFirst({
        where: { sequenceId: req.params.id, leadId, status: 'Active' },
      });
      if (!existing) {
        enrollments.push({ sequenceId: req.params.id, leadId, enrolledById: req.userId, nextSendAt });
      }
    }

    if (enrollments.length > 0) {
      await prisma.emailSequenceEnrollment.createMany({ data: enrollments });
    }

    res.json({ success: true, enrolled: enrollments.length, skipped: (contactIds.length + leadIds.length) - enrollments.length });
  } catch (err) { next(err); }
});

// POST /:id/unenroll - Remove enrollment
// Only this sequence's enrollments, of people the caller can see. This took
// an enrollment id from any sequence, and anyone's contact or lead id.
router.post('/:id/unenroll', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { enrollmentId, contactId, leadId, reason } = req.body;

    if (enrollmentId) {
      const enrollment = await prisma.emailSequenceEnrollment.findFirst({ where: { id: String(enrollmentId), sequenceId: req.params.id } });
      if (!enrollment) return res.status(404).json({ error: 'Not found' });
      if (enrollment.contactId && !(await mayReachPerson(req, res, 'contactId', enrollment.contactId))) return;
      if (enrollment.leadId && !(await mayReachPerson(req, res, 'leadId', enrollment.leadId))) return;
      await prisma.emailSequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: reason || 'Opted Out' },
      });
    } else if (contactId) {
      if (!(await mayReachPerson(req, res, 'contactId', contactId))) return;
      await prisma.emailSequenceEnrollment.updateMany({
        where: { sequenceId: req.params.id, contactId: String(contactId), status: 'Active' },
        data: { status: reason || 'Opted Out' },
      });
    } else if (leadId) {
      if (!(await mayReachPerson(req, res, 'leadId', leadId))) return;
      await prisma.emailSequenceEnrollment.updateMany({
        where: { sequenceId: req.params.id, leadId: String(leadId), status: 'Active' },
        data: { status: reason || 'Opted Out' },
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

/** Whether an address, or its whole domain (`@domain`), is on the suppression list. */
async function suppressed(prisma, address) {
  const email = String(address).trim().toLowerCase();
  return !!(await prisma.emailSuppression.findFirst({ where: { email: { in: [email, `@${email.split('@')[1]}`] } }, select: { id: true } }));
}

// POST /process - Process due enrollments (also run by the job scheduler)
// The scheduler's processSequenceSteps job and this share one implementation
// (services/sequenceSteps): each used to carry its own copy of the loop, and
// both counted a step as sent when the mail was only logged and moved the
// enrollment on whether or not it went. With no SMTP server nothing is sent
// and the answer says so.
router.post('/process', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    res.json(await processDueSteps(prisma, { isSuppressed: address => suppressed(prisma, address) }));
  } catch (err) { next(err); }
});

module.exports = router;
