const { createCrudRouter } = require('../utils/crud');
const { auditMiddleware } = require('../middleware/audit');
const { requirePermission, authenticate } = require('../middleware/auth');

const router = createCrudRouter('campaign', 'campaigns', {
  include: { recipients: { include: { contact: { select: { id: true, firstName: true, lastName: true } }, lead: { select: { id: true, firstName: true, lastName: true } } } }, targetLists: true },
  searchFilter: (q) => ({ name: { contains: q, mode: 'insensitive' } }),
  validate: (data) => {
    const errors = {};
    if (!data.name?.trim()) errors.name = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  customRoutes: (router) => {
    /**
     * Mark a campaign as sent.
     *
     * This used to invent its own results: delivered, opened, clicked and
     * converted were each derived from Math.random(), and revenue was
     * `converted * (1000 + Math.random() * 9000)` — fabricated dollar amounts
     * written to the database and read back by /:id/stats as if measured.
     * Recipients were assigned random statuses the same way. Someone would
     * eventually have made a budget decision on those numbers.
     *
     * It never actually stored them: Campaign has no `metrics` column, so the
     * update threw "Unknown argument `metrics`" and this route answered 500 on
     * every call. Engagement now comes from the CampaignRecipient rows, which
     * is where /:id/stats already reads it from, so there is nothing to invent
     * and no new column to add.
     *
     * Actual delivery is still not implemented: queueing, throttling and
     * unsubscribe handling are a separate piece of work, so no mail is sent.
     */
    router.post('/:id/send', requirePermission('campaigns', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id }, include: { recipients: true } });
        if (!campaign) return res.status(404).json({ error: 'Not found' });

        const queued = campaign.recipients.length;
        const sentAt = new Date();

        await prisma.$transaction([
          prisma.campaign.update({ where: { id: req.params.id }, data: { status: 'Sent' } }),
          prisma.campaignRecipient.updateMany({
            where: { campaignId: req.params.id },
            data: { status: 'queued', sentAt },
          }),
        ]);

        const updated = await prisma.campaign.findUnique({ where: { id: req.params.id }, include: { recipients: true } });
        res.json({
          ...updated,
          delivery: {
            queued,
            implemented: false,
            detail: 'Recipients are queued. No mail is dispatched and no engagement is tracked yet.',
          },
        });
      } catch (err) { next(err); }
    });

    // POST /api/campaigns/:id/recipients
    router.post('/:id/recipients', requirePermission('campaigns', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { contactIds = [], leadIds = [] } = req.body;
        const data = [
          ...contactIds.map(id => ({ campaignId: req.params.id, contactId: id })),
          ...leadIds.map(id => ({ campaignId: req.params.id, leadId: id })),
        ];
        await prisma.campaignRecipient.createMany({ data });
        res.json({ success: true, added: data.length });
      } catch (err) { next(err); }
    });

    // GET /api/campaigns/:id/recipients
    router.get('/:id/recipients', requirePermission('campaigns', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const recipients = await prisma.campaignRecipient.findMany({
          where: { campaignId: req.params.id },
          include: {
            contact: { select: { id: true, firstName: true, lastName: true, email: true } },
            lead: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        });
        res.json({ data: recipients });
      } catch (err) { next(err); }
    });

    // GET /api/campaigns/stats/overview
    router.get('/stats/overview', requirePermission('campaigns', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const campaigns = await prisma.campaign.findMany();
        const totalSent = campaigns.reduce((s, c) => s + (c.metrics?.sent || 0), 0);
        const totalRevenue = campaigns.reduce((s, c) => s + (c.metrics?.revenue || 0), 0);
        const totalCost = campaigns.reduce((s, c) => s + c.actualCost, 0);
        res.json({ total: campaigns.length, totalSent, totalRevenue, totalCost, roi: totalCost > 0 ? ((totalRevenue - totalCost) / totalCost * 100).toFixed(1) : 0 });
      } catch (err) { next(err); }
    });
  },
});

// Campaign members
router.get('/:id/members', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50 } = req.query;
    const [members, total] = await Promise.all([
      prisma.campaignMember.findMany({ where: { campaignId: req.params.id }, include: { contact: { select: { firstName: true, lastName: true, email: true } }, lead: { select: { firstName: true, lastName: true, email: true } } }, skip: (+page - 1) * +limit, take: +limit }),
      prisma.campaignMember.count({ where: { campaignId: req.params.id } }),
    ]);
    res.json({ data: members, total, page: +page });
  } catch (err) { next(err); }
});

router.post('/:id/members', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactIds, leadIds, status } = req.body;
    const added = [];
    for (const cId of (contactIds || [])) {
      const existing = await prisma.campaignMember.findFirst({ where: { campaignId: req.params.id, contactId: cId } });
      if (!existing) { added.push(await prisma.campaignMember.create({ data: { campaignId: req.params.id, contactId: cId, status: status || 'Sent' } })); }
    }
    for (const lId of (leadIds || [])) {
      const existing = await prisma.campaignMember.findFirst({ where: { campaignId: req.params.id, leadId: lId } });
      if (!existing) { added.push(await prisma.campaignMember.create({ data: { campaignId: req.params.id, leadId: lId, status: status || 'Sent' } })); }
    }
    res.json({ added: added.length });
  } catch (err) { next(err); }
});

// Campaign ROI calculation
router.get('/:id/roi', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return res.status(404).json({ error: 'Not found' });
    const members = await prisma.campaignMember.findMany({ where: { campaignId: req.params.id }, include: { contact: { include: { deals: { where: { stage: 'Closed Won' }, select: { value: true } } } } } });
    const totalWonRevenue = members.reduce((s, m) => s + (m.contact?.deals?.reduce((ds, d) => ds + (d.value || 0), 0) || 0), 0);
    const cost = campaign.budgetedCost || campaign.actualCost || 0;
    const roi = cost > 0 ? Math.round(((totalWonRevenue - cost) / cost) * 100) : 0;
    const responses = members.filter(m => m.status === 'Responded').length;
    const converted = members.filter(m => m.status === 'Converted').length;
    res.json({ campaignId: campaign.id, totalMembers: members.length, responses, converted, responseRate: members.length ? Math.round(responses / members.length * 100) : 0, conversionRate: members.length ? Math.round(converted / members.length * 100) : 0, budgetedCost: campaign.budgetedCost || 0, actualCost: campaign.actualCost || 0, wonRevenue: totalWonRevenue, roi, costPerResponse: responses > 0 ? Math.round(cost / responses) : 0, costPerConversion: converted > 0 ? Math.round(cost / converted) : 0 });
  } catch (err) { next(err); }
});

// Campaign email performance
router.get('/:id/email-stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const emails = await prisma.email.findMany({ where: { campaignId: req.params.id }, select: { status: true, openedAt: true, clickedAt: true, bouncedAt: true, unsubscribedAt: true } });
    const total = emails.length;
    const sent = emails.filter(e => e.status === 'Sent' || e.status === 'Delivered').length;
    const opened = emails.filter(e => e.openedAt).length;
    const clicked = emails.filter(e => e.clickedAt).length;
    const bounced = emails.filter(e => e.bouncedAt).length;
    const unsub = emails.filter(e => e.unsubscribedAt).length;
    res.json({ totalEmails: total, sent, opened, clicked, bounced, unsubscribed: unsub, openRate: sent ? Math.round(opened / sent * 100) : 0, clickRate: opened ? Math.round(clicked / opened * 100) : 0, bounceRate: sent ? Math.round(bounced / sent * 100) : 0, unsubRate: sent ? Math.round(unsub / sent * 100) : 0 });
  } catch (err) { next(err); }
});

// Clone campaign
router.post('/:id/clone', authenticate, requirePermission('campaigns', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const orig = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!orig) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, ...data } = orig;
    const clone = await prisma.campaign.create({ data: { ...data, name: `${orig.name} (Copy)`, status: 'Planned', createdById: req.user.id } });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

module.exports = router;
