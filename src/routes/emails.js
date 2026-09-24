const { Router } = require('express');
const { sendEmail } = require('../services/mailer');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { linkRefusal } = require('../middleware/access');
const { columnsFrom } = require('../utils/modelFields');

const router = Router();
router.use(authenticate, auditMiddleware);

// LIST
router.get('/', requirePermission('emails', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, search, page = 1, limit = 50 } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
    let where = {};
    if (status && status !== 'All') where.status = status;
    if (search) where.subject = { contains: search, mode: 'insensitive' };
    const [emails, total] = await Promise.all([
      prisma.email.findMany({
        where,
        include: { contact: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.email.count({ where }),
    ]);
    res.json({ data: emails, meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

// GET ONE
router.get('/:id', requirePermission('emails', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      include: { contact: true, deal: true },
    });
    if (!email) return res.status(404).json({ error: 'Not found' });
    res.json(email);
  } catch (err) { next(err); }
});

// CREATE (draft)
router.post('/', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The email's own columns, linked only to a contact or deal the caller can
    // see: the body went to Prisma whole, so `deal: { update: … }` rewrote a
    // deal and, through its owner, reached users and roles.
    const data = { ...columnsFrom('email', req.body), status: 'draft' };
    const linkProblem = await linkRefusal(req, 'email', data);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const email = await prisma.email.create({ data });
    res.status(201).json(email);
  } catch (err) { next(err); }
});

// CREATE + SEND in one call (frontend shortcut)
router.post('/send', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Spreading req.body straight into create let any unknown key 500 the
    // request, and any known one (opened, openedAt, id) be set by the caller.
    const { subject, body, from, to, toEmail, toName, contactId, dealId, templateId } = req.body || {};
    const linkProblem = await linkRefusal(req, 'email', { contactId, dealId, templateId });
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const recipient = toEmail || to;
    // Actually hand it to a transport, and record what came back rather than
    // asserting 'sent' regardless.
    const delivery = await sendEmail(prisma, {
      to: recipient, subject, body, mailboxId: req.body?.mailboxId,
    });

    const email = await prisma.email.create({
      data: {
        subject, body, from, to, toEmail, toName, contactId, dealId, templateId,
        status: delivery.status,
        sentAt: delivery.delivered ? new Date() : null,
      },
      include: { contact: { select: { id: true, firstName: true, lastName: true } } },
    });

    await req.audit({ action: 'create', module: 'emails', recordId: email.id, details: `Email to ${recipient}: ${delivery.status}` });
    res.status(201).json({ ...email, delivery });
  } catch (err) { next(err); }
});

// SEND
router.post('/:id/send', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const draft = await prisma.email.findUnique({ where: { id: req.params.id } });
    if (!draft) return res.status(404).json({ error: 'Not found' });

    const delivery = await sendEmail(prisma, {
      to: draft.toEmail || draft.to,
      subject: draft.subject,
      body: draft.body,
      mailboxId: req.body?.mailboxId,
    });

    const email = await prisma.email.update({
      where: { id: req.params.id },
      data: { status: delivery.status, sentAt: delivery.delivered ? new Date() : null },
    });

    await req.audit({ action: 'update', module: 'emails', recordId: email.id, details: `Send attempt: ${delivery.status}` });
    res.json({ ...email, delivery });
  } catch (err) { next(err); }
});

// Track open
router.post('/:id/track-open', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.email.update({
      where: { id: req.params.id },
      data: { opened: true, openedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.email.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const data = columnsFrom('email', req.body);
    const linkProblem = await linkRefusal(req, 'email', data, current);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const email = await prisma.email.update({ where: { id: req.params.id }, data });
    res.json(email);
  } catch (err) { next(err); }
});

// DELETE
router.delete('/:id', requirePermission('emails', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const record = await prisma.email.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ error: 'Not found' });

    await prisma.email.delete({ where: { id: req.params.id } });

    // Recycle bin snapshot
    try {
      await prisma.recycleBinItem.create({
        data: {
          module: 'emails', recordId: req.params.id,
          recordData: record, deletedById: req.userId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    } catch (e) { /* best-effort */ }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── TEMPLATES ───
router.get('/templates/all', requirePermission('emails', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const templates = await prisma.emailTemplate.findMany({ orderBy: { name: 'asc' } });
    res.json({ data: templates });
  } catch (err) { next(err); }
});

router.post('/templates', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.emailTemplate.create({ data: columnsFrom('emailTemplate', req.body) });
    res.status(201).json(template);
  } catch (err) { next(err); }
});

router.put('/templates/:id', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.emailTemplate.update({ where: { id: req.params.id }, data: columnsFrom('emailTemplate', req.body) });
    res.json(template);
  } catch (err) { next(err); }
});

router.delete('/templates/:id', requirePermission('emails', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.emailTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
