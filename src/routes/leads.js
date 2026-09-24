const { createCrudRouter } = require('../utils/crud');
const { authenticate } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { resolveDealCurrency } = require('../utils/currency');
const { summaryRoute } = require('../utils/moduleStatus');

const router = createCrudRouter('lead', 'leads', {
  include: { assignedTo: { select: { id: true, firstName: true, lastName: true } }, customValues: { include: { customField: true } } },
  searchFilter: (q) => ({
    OR: [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { company: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.firstName?.trim()) errors.firstName = 'Required';
    if (!data.lastName?.trim()) errors.lastName = 'Required';
    if (!data.company?.trim()) errors.company = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  customRoutes: (router) => {
    // POST /api/leads/:id/convert - Convert lead to contact (+ optional account/deal)
    router.post('/:id/convert', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        const { createAccount, createDeal, dealName, dealValue } = req.body;
        const result = {};

        // Create account from lead company if requested
        let accountId = null;
        if (createAccount && lead.company) {
          result.account = await prisma.account.create({
            data: {
              name: lead.company,
              type: 'Prospect',
              phone: lead.phone,
            },
          });
          accountId = result.account.id;
        }

        // Create contact from lead
        result.contact = await prisma.contact.create({
          data: {
            firstName: lead.firstName,
            lastName: lead.lastName,
            email: lead.email,
            phone: lead.phone,
            title: lead.title,
            source: lead.source,
            status: 'Active',
            description: `Converted from lead. Company: ${lead.company}`,
            accountId,
          },
        });

        // Create deal if requested
        if (createDeal) {
          result.deal = await prisma.deal.create({
            data: {
              name: dealName || `${lead.company} - New Deal`,
              value: dealValue || lead.value || 0,
              currency: await resolveDealCurrency(prisma, req.body.dealCurrency),
              stage: 'Qualification',
              contactId: result.contact.id,
              accountId,
              ownerId: req.userId,
            },
          });
        }

        // Update lead as converted
        await prisma.lead.update({
          where: { id: lead.id },
          data: { convertedAt: new Date(), contactId: result.contact.id, status: 'Converted' },
        });

        await req.audit({ action: 'update', module: 'leads', recordId: lead.id, details: `Converted lead to contact ${result.contact.id}` });
        res.json(result);
      } catch (err) { next(err); }
    });

    // POST /api/leads/import-csv
    router.post('/import-csv', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { records } = req.body;
        if (!records || !Array.isArray(records)) return res.status(400).json({ error: 'records array required' });
        const created = await prisma.lead.createMany({ data: records, skipDuplicates: true });
        res.json({ success: true, imported: created.count });
      } catch (err) { next(err); }
    });

    // GET /api/leads/:id/duplicates
    router.get('/:id/duplicates', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
        if (!lead) return res.status(404).json({ error: 'Not found' });
        const dupes = await prisma.lead.findMany({
          where: {
            id: { not: lead.id },
            OR: [
              { AND: [{ firstName: lead.firstName }, { lastName: lead.lastName }] },
              ...(lead.email ? [{ email: lead.email }] : []),
              ...(lead.company ? [{ company: lead.company }] : []),
            ],
          },
        });
        res.json(dupes);
      } catch (err) { next(err); }
    });

    // POST /api/leads/:id/score - Recalculate lead score based on rules
    router.post('/:id/score', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
        if (!lead) return res.status(404).json({ error: 'Not found' });

        const rules = await prisma.leadScoringRule.findMany({ where: { active: true } });
        let score = 50; // Base score
        for (const rule of rules) {
          const fieldVal = String(lead[rule.field] || '').toLowerCase();
          const ruleVal = rule.value.toLowerCase();
          let match = false;
          switch (rule.operator) {
            case 'equals': match = fieldVal === ruleVal; break;
            case 'contains': match = fieldVal.includes(ruleVal); break;
            case 'startsWith': match = fieldVal.startsWith(ruleVal); break;
            case 'endsWith': match = fieldVal.endsWith(ruleVal); break;
            case 'notEquals': match = fieldVal !== ruleVal; break;
          }
          if (match) score += rule.points;
        }
        score = Math.max(0, Math.min(100, score));

        const updated = await prisma.lead.update({ where: { id: lead.id }, data: { score } });
        res.json({ ...updated, rulesApplied: rules.length });
      } catch (err) { next(err); }
    });
  },
});

// Totals from the module's own table.
summaryRoute(router, { module: 'leads', model: 'lead' });

module.exports = router;
