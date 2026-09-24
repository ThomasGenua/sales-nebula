const { Router } = require('express');
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { validate, schemas } = require('../middleware/validate');
const { fireWebhookEvent } = require('../services/webhooks');
const { assertPublicHttpUrl } = require('../utils/outboundUrl');

const router = Router();
router.use(authenticate, auditMiddleware);

// Events typed into a form arrive as one comma-separated string; the API
// stores a list.
const eventList = (req, res, next) => {
  if (typeof req.body?.events === 'string') req.body.events = req.body.events.split(',').map(s => s.trim()).filter(Boolean);
  next();
};

// LIST webhooks
// Paged, searched and filtered as the Webhooks page asks, with a total and
// when each last fired. Every webhook came back whatever the page, search or
// status filter, and "Last Triggered" read a column there is not.
router.get('/', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search, active } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const current = Math.max(parseInt(page) || 1, 1);
    const where = {};
    if (active === 'true' || active === 'false') where.active = active === 'true';
    if (search) where.OR = [{ name: { contains: String(search), mode: 'insensitive' } }, { url: { contains: String(search), mode: 'insensitive' } }];
    const [webhooks, total] = await Promise.all([
      prisma.webhook.findMany({
        where,
        include: { _count: { select: { logs: true } }, logs: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (current - 1) * take, take,
      }),
      prisma.webhook.count({ where }),
    ]);
    // Mask secrets
    const safe = webhooks.map(({ logs, ...w }) => ({ ...w, secret: w.secret ? '****' : null, lastTriggered: logs[0]?.createdAt || null }));
    res.json({ data: safe, total, page: current, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// GET one webhook with recent logs
router.get('/:id', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const webhook = await prisma.webhook.findUnique({
      where: { id: req.params.id },
      include: { logs: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    if (!webhook) return res.status(404).json({ error: 'Not found' });
    webhook.secret = webhook.secret ? '****' : null;
    webhook.lastTriggered = webhook.logs[0]?.createdAt || null;
    res.json(webhook);
  } catch (err) { next(err); }
});

// CREATE webhook
router.post('/', requirePermission('settings', 'full'), eventList, validate(schemas.createWebhook), async (req, res, next) => {
  try {
    // The server will request this URL, so it must not be able to reach
    // the metadata endpoint or anything else behind the firewall.
    if (req.body.url !== undefined) {
      const verdict = await assertPublicHttpUrl(req.body.url);
      if (!verdict.ok) return res.status(400).json({ error: `Webhook URL rejected: ${verdict.reason}`, code: 'UNSAFE_WEBHOOK_URL' });
    }

    const prisma = req.app.locals.prisma;
    const { name, url, events, headers, retries } = req.body;
    const secret = crypto.randomBytes(32).toString('hex');

    const webhook = await prisma.webhook.create({
      data: {
        name, url, events, secret,
        // Left out rather than null: a Json column refuses a plain null, so a
        // webhook created without custom headers failed.
        ...(headers && { headers }),
        retries: retries || 3,
        createdById: req.userId,
      },
    });

    await req.audit({ action: 'create', module: 'settings', recordId: webhook.id, details: `Created webhook: ${name}` });
    // Return secret only on creation
    res.status(201).json(webhook);
  } catch (err) { next(err); }
});

// UPDATE webhook
router.put('/:id', requirePermission('settings', 'full'), eventList, async (req, res, next) => {
  try {
    // The server will request this URL, so it must not be able to reach
    // the metadata endpoint or anything else behind the firewall.
    if (req.body.url !== undefined) {
      const verdict = await assertPublicHttpUrl(req.body.url);
      if (!verdict.ok) return res.status(400).json({ error: `Webhook URL rejected: ${verdict.reason}`, code: 'UNSAFE_WEBHOOK_URL' });
    }

    const prisma = req.app.locals.prisma;
    const { name, url, events, active, headers, retries } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (url !== undefined) data.url = url;
    if (events !== undefined) data.events = events;
    if (active !== undefined) data.active = active;
    // The edit form sends the row back, `headers: null` included; a Json
    // column is emptied with DbNull, and a plain null failed the update.
    if (headers !== undefined) data.headers = headers === null ? Prisma.DbNull : headers;
    if (retries !== undefined) data.retries = retries;

    const webhook = await prisma.webhook.update({ where: { id: req.params.id }, data });
    webhook.secret = webhook.secret ? '****' : null;
    res.json(webhook);
  } catch (err) { next(err); }
});

// DELETE webhook
router.delete('/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.webhook.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// REGENERATE secret
router.post('/:id/regenerate-secret', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const secret = crypto.randomBytes(32).toString('hex');
    const webhook = await prisma.webhook.update({ where: { id: req.params.id }, data: { secret } });
    res.json({ secret: webhook.secret }); // Return new secret
  } catch (err) { next(err); }
});

// TEST webhook - send a test payload
router.post('/:id/test', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const webhook = await prisma.webhook.findUnique({ where: { id: req.params.id } });
    if (!webhook) return res.status(404).json({ error: 'Not found' });

    await fireWebhookEvent(prisma, 'test.ping', {
      message: 'Test webhook delivery',
      timestamp: new Date().toISOString(),
      webhookId: webhook.id,
    });

    res.json({ success: true, message: 'Test event queued for delivery' });
  } catch (err) { next(err); }
});

// GET webhook logs
router.get('/:id/logs', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50 } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

    const [logs, total] = await Promise.all([
      prisma.webhookLog.findMany({
        where: { webhookId: req.params.id },
        orderBy: { createdAt: 'desc' },
        skip, take,
      }),
      prisma.webhookLog.count({ where: { webhookId: req.params.id } }),
    ]);

    res.json({ data: logs, meta: { total, page: parseInt(page), limit: take } });
  } catch (err) { next(err); }
});

// GET available events
router.get('/events/list', async (req, res, next) => {
  res.json({
    data: [
      'contact.created', 'contact.updated', 'contact.deleted',
      'lead.created', 'lead.updated', 'lead.deleted', 'lead.converted', 'lead.scored',
      'deal.created', 'deal.updated', 'deal.deleted', 'deal.stage_changed',
      'account.created', 'account.updated', 'account.deleted',
      'case.created', 'case.updated', 'case.escalated', 'case.resolved',
      'quote.created', 'quote.accepted',
      'invoice.created', 'invoice.paid',
      'activity.created', 'activity.completed',
      'forecast.submitted', 'forecast.approved',
      'approval.requested', 'approval.completed',
      'test.ping', '*',
    ],
  });
});

module.exports = router;
