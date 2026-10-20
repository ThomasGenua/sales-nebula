const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { auditMiddleware } = require('../middleware/audit');
const { summaryRoute } = require('../utils/moduleStatus');
const { columnsFrom, modelHasField } = require('../utils/modelFields');
const { updateRecord, deleteRecord, runAfter } = require('../services/recordWrites');

const router = Router();
router.use(authenticate, auditMiddleware);

const MODEL_MAP = { contacts: 'contact', leads: 'lead', accounts: 'account' };
const MATCH_FIELDS = {
  contact: ['email', 'phone', 'firstName', 'lastName'],
  lead: ['email', 'phone', 'firstName', 'lastName', 'company'],
  account: ['name', 'website', 'phone'],
};

// ─── DUPLICATE RULES CRUD ───
router.get('/rules', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.duplicateRule.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: rules });
  } catch (err) { next(err); }
});

router.post('/rules', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.duplicateRule.create({ data: columnsFrom('duplicateRule', req.body) });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/rules/:id', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rule = await prisma.duplicateRule.update({ where: { id: req.params.id }, data: columnsFrom('duplicateRule', req.body) });
    res.json(rule);
  } catch (err) { next(err); }
});

router.delete('/rules/:id', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.duplicateRule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── DUPLICATE DETECTION ───
router.post('/check/:module', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.params;
    const modelName = MODEL_MAP[module];
    if (!modelName || !prisma[modelName]) return res.status(400).json({ error: 'Invalid module' });
    // Matches come back whole, so they are the module's records the caller
    // could open anyway; this answered anyone signed in, about every record.
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });

    const record = req.body || {};
    const rules = await prisma.duplicateRule.findMany({ where: { module, active: true } });

    const duplicates = [];
    for (const rule of rules) {
      const matchFields = rule.matchFields || [];
      for (const mf of matchFields) {
        const val = record[mf.field];
        if (!val || !['string', 'number'].includes(typeof val)) continue;
        const matches = await prisma[modelName].findMany({
          where: await reachableWhere(req, module, modelName, { [mf.field]: { equals: val, mode: 'insensitive' } }),
          take: 10,
        });
        for (const match of matches) {
          if (match.id === record.id) continue;
          let score = mf.weight || 50;
          // Check additional fields for higher confidence
          matchFields.forEach(f => {
            if (f.field !== mf.field && record[f.field] && match[f.field]) {
              if (String(record[f.field]).toLowerCase() === String(match[f.field]).toLowerCase()) {
                score = Math.min(100, score + (f.weight || 20));
              }
            }
          });
          if (score >= rule.threshold) {
            duplicates.push({ record: match, score, rule: rule.name, matchedOn: mf.field, action: rule.action });
          }
        }
      }
    }

    // Deduplicate results
    const seen = new Set();
    const unique = duplicates.filter(d => {
      if (seen.has(d.record.id)) return false;
      seen.add(d.record.id);
      return true;
    });

    res.json({ duplicates: unique, blocked: unique.some(d => d.action === 'block') });
  } catch (err) { next(err); }
});

// ─── MERGE ───
router.post('/merge/:module', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.params;
    const { masterId, fieldOverrides } = req.body;
    const modelName = MODEL_MAP[module];
    if (!modelName) return res.status(400).json({ error: 'Invalid module' });
    if (!permits(req, module, 'full')) return res.status(403).json({ error: `Full ${module} permission is required to merge` });
    // Records other than the master: naming the master here deleted it.
    const mergeIds = Array.isArray(req.body.mergeIds) ? req.body.mergeIds.map(String).filter(id => id !== String(masterId)) : [];
    if (!masterId || !mergeIds.length) return res.status(400).json({ error: 'masterId and mergeIds required' });
    if (mergeIds.length > 50 || new Set(mergeIds).size !== mergeIds.length) return res.status(400).json({ error: 'Choose up to 50 distinct source records' });
    const accessible = await prisma[modelName].count({ where: await reachableWhere(req, module, modelName, { id: { in: [String(masterId), ...mergeIds] } }, 'Full') });
    if (accessible !== mergeIds.length + 1) return res.status(404).json({ error: 'One or more records are unavailable for merge' });

    const after = [];
    const result = await prisma.$transaction(async tx => {
    const master = await tx[modelName].findFirst({ where: { id: String(masterId), deletedAt: null } });
    if (!master) throw Object.assign(new Error('Master record not found'), { status: 404 });

    // Apply field overrides to master, as an edit would
    // (services/recordWrites): its rules, links the caller can see, its
    // workflows and webhooks. Its own columns, not its deleted marker:
    // overrides went to Prisma whole.
    if (fieldOverrides && Object.keys(fieldOverrides).length > 0) {
      const { deletedAt, ...overrides } = columnsFrom(modelName, fieldOverrides);
      await updateRecord(tx, module, master, overrides, { req, userId: req.userId, source: 'duplicate merge', mergingWith: mergeIds, after, prisma });
    }

    // Reassign child records from merge targets to master. An account's
    // contacts and contracts stayed behind, as did a contact's or lead's
    // campaign memberships (the account merge in accounts.js moves them).
    const fkField = module === 'contacts' ? 'contactId' : module === 'leads' ? 'leadId' : 'accountId';
    const childModels = ['activity', 'email', 'note', 'case', 'deal', 'document', 'quote', 'invoice', 'contact', 'contract', 'campaignRecipient']
      .filter(child => modelHasField(child, fkField));

    let merged = 0;
    for (const mergeId of mergeIds) {
      for (const child of childModels) {
        if (tx[child]) {
            await tx[child].updateMany({ where: { [fkField]: mergeId }, data: { [fkField]: master.id } });
        }
      }
      // Soft delete the merged record, with its recycle bin entry, as the
      // bin expects. It was deleted outright: that emptied the account link of
      // every contact left pointing at it, or failed on a linked contract,
      // unseen, and left the duplicate in place while reporting it merged.
      // Deleted as a delete is (services/recordWrites), so its webhook fires.
        const record = await tx[modelName].findFirst({ where: { id: mergeId, deletedAt: null } });
        if (record) {
          await deleteRecord(tx, module, record, {
            req, userId: req.userId, source: `merged into ${master.id}`,
            after, prisma,
            alsoSet: modelHasField(modelName, 'mergedIntoId') ? { mergedIntoId: master.id } : {},
          });
          merged++;
        }
    }

    return { master: await tx[modelName].findUnique({ where: { id: master.id } }), mergedCount: merged };
    }, { isolationLevel: 'Serializable', timeout: 30000 });
    await runAfter(after);
    await req.audit({ action: 'update', module, recordId: result.master.id, details: `Merged ${result.mergedCount} records` });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'duplicates', model: 'duplicateRule' });
