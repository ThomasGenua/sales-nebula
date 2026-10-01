const { createCrudRouter } = require('../utils/crud');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { editableFields } = require('../utils/modelFields');
const { resolveDealCurrency } = require('../utils/currency');
const { summaryRoute } = require('../utils/moduleStatus');
const { fireWebhookEvent } = require('../services/webhooks');

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
    // It creates a contact, and an account and a deal when asked, so it takes
    // those modules' edit permission too: leads edit alone created all three.
    router.post('/:id/convert', requirePermission('contacts', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const lead = await prisma.lead.findFirst({ where: { id: req.params.id, deletedAt: null } });
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        // Converting again made a second contact (and account, and deal).
        if (lead.convertedAt) return res.status(409).json({ error: 'This lead has already been converted', contactId: lead.contactId });

        const { createAccount, createDeal, dealName, dealValue } = req.body;
        for (const [asked, module] of [[createAccount, 'accounts'], [createDeal, 'deals']]) {
          if (asked && !permits(req, module, 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
        }
        let closeDate;
        if (createDeal && req.body.dealCloseDate) {
          closeDate = new Date(req.body.dealCloseDate);
          if (!Number.isFinite(closeDate.getTime())) return res.status(400).json({ error: 'A valid deal close date is required' });
        }
        if (createDeal && req.body.dealValue !== undefined && (!Number.isFinite(Number(dealValue)) || Number(dealValue) < 0)) {
          return res.status(400).json({ error: 'Deal value must be zero or more' });
        }
        const result = await prisma.$transaction(async tx => {
          // Claim the unconverted lead in this transaction. A concurrent click
          // waits for this write and then sees no row to claim; any failed
          // contact/account/deal write rolls the claim and all records back.
          const claimed = await tx.lead.updateMany({ where: { id: lead.id, convertedAt: null, deletedAt: null }, data: { convertedAt: new Date(), status: 'Converted' } });
          if (!claimed.count) { const error = new Error('This lead has already been converted'); error.status = 409; throw error; }
          const result = {};

          // Create account from lead company if requested
          let accountId = null;
          if (createAccount && lead.company) {
            // Owned by whoever converted the lead, as the deal is: with no
            // owner, a Private default hid the account and contact from them.
            result.account = await tx.account.create({
              data: {
                name: lead.company,
                type: 'Prospect',
                phone: lead.phone,
                ownerId: req.userId,
                createdById: req.userId,
              },
            });
            accountId = result.account.id;
          }

          // Create contact from lead
          result.contact = await tx.contact.create({
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
              ownerId: req.userId,
            },
          });

          // Create deal if requested
          if (createDeal) {
            result.deal = await tx.deal.create({
              data: {
                name: dealName || `${lead.company} - New Deal`,
                value: dealValue == null ? lead.value || 0 : Number(dealValue),
                currency: await resolveDealCurrency(tx, req.body.dealCurrency),
                stage: 'Qualification',
                ...(closeDate && { closeDate }),
                contactId: result.contact.id,
                accountId,
                ownerId: req.userId,
              },
            });
          }

          // Update lead as converted
          await tx.lead.update({
            where: { id: lead.id },
            data: { convertedAt: new Date(), contactId: result.contact.id, status: 'Converted' },
          });

          return result;
        }, { timeout: 30000 });

        await req.audit({ action: 'update', module: 'leads', recordId: lead.id, details: `Converted lead to contact ${result.contact.id}` });
        // The webhook events list offers lead.converted; nothing fired it.
        await fireWebhookEvent(prisma, 'lead.converted', { id: lead.id, contactId: result.contact.id, accountId: result.account?.id || null, dealId: result.deal?.id || null });
        res.json(result);
      } catch (err) { next(err); }
    });

    // POST /api/leads/import-csv
    router.post('/import-csv', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { records } = req.body;
        if (!records || !Array.isArray(records)) return res.status(400).json({ error: 'records array required' });
        // Each row as the lead's own columns, owned by the importer, as contact
        // imports are. Rows went in whole: a column the model lacks failed the
        // whole import, and a row could set its id, dates or another owner.
        const data = records.map(row => ({ ...editableFields('lead', row), ownerId: req.userId }));
        const seen = new Map();
        for (const [i, row] of data.entries()) {
          if (!row.firstName || !row.lastName || !row.company) return res.status(400).json({ error: 'firstName, lastName and company are required', row: i + 1 });
          const linkProblem = await linkRefusal(req, 'lead', row, null, seen);
          if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE', row: i + 1 });
        }
        const created = await prisma.lead.createMany({ data, skipDuplicates: true });
        res.json({ success: true, imported: created.count });
      } catch (err) { next(err); }
    });

    // GET /api/leads/:id/duplicates
    router.get('/:id/duplicates', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
        if (!lead) return res.status(404).json({ error: 'Not found' });
        // Whole records, so only live leads the caller could open anyway, as
        // for contacts; this listed deleted leads and anyone's.
        const dupes = await prisma.lead.findMany({
          where: await reachableWhere(req, 'leads', 'lead', {
            id: { not: lead.id },
            OR: [
              { AND: [{ firstName: lead.firstName }, { lastName: lead.lastName }] },
              ...(lead.email ? [{ email: lead.email }] : []),
              ...(lead.company ? [{ company: lead.company }] : []),
            ],
          }),
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
            // Rules can be written with these (a lead's value or score), and
            // matched nothing.
            case 'greaterThan': match = Number(lead[rule.field]) > Number(rule.value); break;
            case 'lessThan': match = Number(lead[rule.field]) < Number(rule.value); break;
          }
          if (match) score += rule.points;
        }
        score = Math.max(0, Math.min(100, score));

        const updated = await prisma.lead.update({ where: { id: lead.id }, data: { score } });
        await fireWebhookEvent(prisma, 'lead.scored', { id: updated.id, score: updated.score });
        res.json({ ...updated, rulesApplied: rules.length });
      } catch (err) { next(err); }
    });
  },
});

// Totals from the module's own table.
summaryRoute(router, { module: 'leads', model: 'lead' });

module.exports = router;
