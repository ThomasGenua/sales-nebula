const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { auditMiddleware } = require('../middleware/audit');
const { summaryRoute } = require('../utils/moduleStatus');
const { columnsFrom, modelHasField } = require('../utils/modelFields');

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
    // Records other than the master: naming the master here deleted it.
    const mergeIds = Array.isArray(req.body.mergeIds) ? req.body.mergeIds.map(String).filter(id => id !== String(masterId)) : [];
    if (!masterId || !mergeIds.length) return res.status(400).json({ error: 'masterId and mergeIds required' });

    const master = await prisma[modelName].findFirst({ where: { id: String(masterId), deletedAt: null } });
    if (!master) return res.status(404).json({ error: 'Master record not found' });

    // Apply field overrides to master
    if (fieldOverrides && Object.keys(fieldOverrides).length > 0) {
      // The master's own columns: overrides went to Prisma whole.
      await prisma[modelName].update({ where: { id: master.id }, data: columnsFrom(modelName, fieldOverrides) });
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
        if (prisma[child]) {
          try {
            await prisma[child].updateMany({ where: { [fkField]: mergeId }, data: { [fkField]: master.id } });
          } catch (e) { /* FK might not exist on this model */ }
        }
      }
      // Soft delete the merged record, with its recycle bin entry, as the
      // bin expects. It was deleted outright: that emptied the account link of
      // every contact left pointing at it, or failed on a linked contract,
      // unseen, and left the duplicate in place while reporting it merged.
      try {
        const record = await prisma[modelName].findFirst({ where: { id: mergeId, deletedAt: null } });
        if (record) {
          await prisma.recycleBinItem.create({
            data: { module, recordId: mergeId, recordData: record, deletedById: req.userId, expiresAt: new Date(Date.now() + 30 * 86400000) },
          });
          await prisma[modelName].update({
            where: { id: mergeId },
            data: { deletedAt: new Date(), ...(modelHasField(modelName, 'mergedIntoId') && { mergedIntoId: master.id }) },
          });
          merged++;
        }
      } catch (e) { /* best-effort */ }
    }

    await req.audit({ action: 'update', module, recordId: master.id, details: `Merged ${merged} records` });
    const result = await prisma[modelName].findUnique({ where: { id: master.id } });
    res.json({ master: result, mergedCount: merged });
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'duplicates', model: 'duplicateRule' });
