const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

// LIST sequences
router.get('/', requirePermission('emails', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sequences = await prisma.emailSequence.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { enrollments: true } } },
    });
    res.json({ data: sequences.map(s => ({ ...s, enrollmentCount: s._count.enrollments })) });
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

    // Enrollment stats
    const active = sequence.enrollments.filter(e => e.status === 'Active').length;
    const completed = sequence.enrollments.filter(e => e.status === 'Completed').length;
    const optedOut = sequence.enrollments.filter(e => e.status === 'Opted Out').length;

    res.json({ ...sequence, stats: { total: sequence._count.enrollments, active, completed, optedOut } });
  } catch (err) { next(err); }
});

// CREATE
router.post('/', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, steps } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    if (!steps || !Array.isArray(steps) || steps.length === 0) return res.status(400).json({ error: 'At least one step required' });

    const sequence = await prisma.emailSequence.create({
      data: { name, description, steps, createdById: req.userId },
    });
    await req.audit({ action: 'create', module: 'emails', recordId: sequence.id, details: `Created email sequence: ${name}` });
    res.status(201).json(sequence);
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, updatedAt, enrollments, _count, stats, ...data } = req.body;
    const sequence = await prisma.emailSequence.update({ where: { id: req.params.id }, data });
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
    if (contactIds.length === 0 && leadIds.length === 0) {
      return res.status(400).json({ error: 'At least one contactId or leadId required' });
    }

    const sequence = await prisma.emailSequence.findUnique({ where: { id: req.params.id } });
    if (!sequence) return res.status(404).json({ error: 'Not found' });
    if (sequence.status !== 'Active') return res.status(400).json({ error: 'Sequence must be active to enroll' });

    const steps = typeof sequence.steps === 'string' ? JSON.parse(sequence.steps) : sequence.steps;
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
router.post('/:id/unenroll', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { enrollmentId, contactId, leadId, reason } = req.body;

    if (enrollmentId) {
      await prisma.emailSequenceEnrollment.update({
        where: { id: enrollmentId },
        data: { status: reason || 'Opted Out' },
      });
    } else if (contactId) {
      await prisma.emailSequenceEnrollment.updateMany({
        where: { sequenceId: req.params.id, contactId, status: 'Active' },
        data: { status: reason || 'Opted Out' },
      });
    } else if (leadId) {
      await prisma.emailSequenceEnrollment.updateMany({
        where: { sequenceId: req.params.id, leadId, status: 'Active' },
        data: { status: reason || 'Opted Out' },
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /process - Process due enrollments (called by job scheduler)
router.post('/process', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const due = await prisma.emailSequenceEnrollment.findMany({
      where: { status: 'Active', nextSendAt: { lte: new Date() } },
      include: { sequence: true },
    });

    let sent = 0;
    let completed = 0;

    for (const enrollment of due) {
      const steps = typeof enrollment.sequence.steps === 'string'
        ? JSON.parse(enrollment.sequence.steps) : enrollment.sequence.steps;

      if (enrollment.currentStep >= steps.length) {
        await prisma.emailSequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'Completed', completedAt: new Date() },
        });
        completed++;
        continue;
      }

      const step = steps[enrollment.currentStep];

      // Create the email record
      const emailData = {
        subject: step.subject || `Sequence step ${enrollment.currentStep + 1}`,
        body: step.body || '',
        status: 'sent',
        sentAt: new Date(),
      };
      if (enrollment.contactId) emailData.contactId = enrollment.contactId;
      await prisma.email.create({ data: emailData });

      // Advance to next step
      const nextStep = enrollment.currentStep + 1;
      if (nextStep >= steps.length) {
        await prisma.emailSequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { currentStep: nextStep, status: 'Completed', completedAt: new Date(), nextSendAt: null },
        });
        completed++;
      } else {
        const nextDelay = steps[nextStep]?.delayDays || 1;
        await prisma.emailSequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { currentStep: nextStep, nextSendAt: new Date(Date.now() + nextDelay * 86400000) },
        });
      }
      sent++;
    }

    res.json({ processed: due.length, sent, completed });
  } catch (err) { next(err); }
});

module.exports = router;
