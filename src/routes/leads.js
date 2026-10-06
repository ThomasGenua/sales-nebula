const { createCrudRouter } = require('../utils/crud');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { editableFields } = require('../utils/modelFields');
const { summaryRoute } = require('../utils/moduleStatus');
const { fireWebhookEvent } = require('../services/webhooks');
const { createRecord, updateRecord, runAfter } = require('../services/recordWrites');

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
        // The account, contact and deal are made as on their own pages, with
        // their modules' rules and hooks (services/recordWrites), and the lead
        // changes as an edit would; their workflows and webhooks run once
        // the conversion has committed. None of it ran: a rule on new
        // contacts never saw a converted one. A rule that refuses one of them
        // refuses the conversion. The links are to the records made here, so
        // they are not checked against what the caller can see (the check
        // would look outside the transaction and not find them).
        const after = [];
        const write = { userId: req.userId, source: 'lead conversion', emit: req.app.locals.emit, after, prisma };
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
            ({ record: result.account } = await createRecord(tx, 'accounts', {
              name: lead.company,
              type: 'Prospect',
              phone: lead.phone,
              ownerId: req.userId,
            }, write));
            accountId = result.account.id;
          }

          // Create contact from lead
          ({ record: result.contact } = await createRecord(tx, 'contacts', {
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
          }, write));

          // Create deal if requested; the deal's own rules resolve its currency.
          if (createDeal) {
            ({ record: result.deal } = await createRecord(tx, 'deals', {
              name: dealName || `${lead.company} - New Deal`,
              value: dealValue == null ? lead.value || 0 : Number(dealValue),
              currency: req.body.dealCurrency,
              stage: 'Qualification',
              ...(closeDate && { closeDate }),
              contactId: result.contact.id,
              accountId,
              ownerId: req.userId,
            }, write));
          }

          // Update lead as converted: from the lead as it was before the claim,
          // so its rules see the move to Converted.
          await updateRecord(tx, 'leads', lead, { convertedAt: new Date(), contactId: result.contact.id, status: 'Converted' }, write);

          return result;
        }, { timeout: 30000 });
        await runAfter(after);

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
        // Each row as the lead's own columns. Rows went in whole: a column the
        // model lacks failed the whole import, and a row could set its id,
        // dates or another owner.
        const data = records.map(row => editableFields('lead', row));
        const seen = new Map();
        for (const [i, row] of data.entries()) {
          if (!row.firstName || !row.lastName || !row.company) return res.status(400).json({ error: 'firstName, lastName and company are required', row: i + 1 });
          const linkProblem = await linkRefusal(req, 'lead', row, null, seen);
          if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE', row: i + 1 });
        }
        // Each lead as one made on its page: its rules, an owner from the
        // assignment rules or else the importer, then its workflows. All or
        // none, as before: a row a rule refuses fails the file, by row.
        const after = [];
        const write = { userId: req.userId, source: 'import', emit: req.app.locals.emit, after, prisma };
        await prisma.$transaction(async tx => {
          for (const [i, row] of data.entries()) {
            try {
              await createRecord(tx, 'leads', row, write);
            } catch (err) {
              if (err.body) err.body = { ...err.body, row: i + 1 };
              throw err;
            }
          }
        }, { timeout: 120000 });
        await runAfter(after);
        res.json({ success: true, imported: data.length });
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

        // Through the lead's rules, so a workflow on its score sees the change.
        const { record: updated } = await updateRecord(prisma, 'leads', lead, { score }, { req, userId: req.userId, source: 'scoring' });
        await fireWebhookEvent(prisma, 'lead.scored', { id: updated.id, score: updated.score });
        res.json({ ...updated, rulesApplied: rules.length });
      } catch (err) { next(err); }
    });
  },
});

// Totals from the module's own table.
summaryRoute(router, { module: 'leads', model: 'lead' });

module.exports = router;
