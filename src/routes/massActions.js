const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { editableFields, modelHasField } = require('../utils/modelFields');
const {
  updateRecord, deleteRecord, batchClient, isRecordModule, RecordWriteError,
} = require('../services/recordWrites');

const router = Router();
router.use(authenticate, auditMiddleware);

/*
 * These took a session alone: anyone signed in could rewrite any columns
 * (owners included) on, delete, or reassign up to 200 records at a time in
 * fifteen modules. Each action now takes the module's permission and reaches
 * only records the caller may change.
 *
 * And each record changes as it would on its own page
 * (services/recordWrites): the module's validation rules and hooks, its
 * workflows and webhooks. They were one updateMany, which none of them saw:
 * a mass stage change kept no stage history, a mass close left cases
 * without a closing date, a rule that refused a value let it through. A
 * record a rule refuses keeps its values and is listed in `failed`. Emails,
 * which no rule reads, are still changed together.
 */

/** Change each record through the write service, collecting the ones refused. */
async function eachRecord(req, records, write) {
  const db = batchClient(req.app.locals.prisma);
  const ctx = { req, userId: req.userId, source: 'mass action', linkCache: new Map() };
  let done = 0;
  const failed = [];
  for (const record of records) {
    try {
      await write(db, record, ctx);
      done++;
    } catch (err) {
      if (!(err instanceof RecordWriteError)) throw err;
      failed.push({ id: record.id, error: err.body.error, ...(err.code ? { code: err.code } : {}) });
    }
  }
  return { done, failed };
}

/** Records not in the recycle bin, where the model has one. */
const live = model => (modelHasField(model, 'deletedAt') ? { deletedAt: null } : {});

/** The caller may act on `module` at `level`; otherwise answer and return false. */
function allowed(req, res, module, level) {
  if (permits(req, module, level)) return true;
  res.status(403).json({ error: `Insufficient permissions for ${module}` });
  return false;
}

const MODULE_MAP = {
  contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
  activities: 'activity', cases: 'case', products: 'product',
  quotes: 'quote', invoices: 'invoice', campaigns: 'campaign',
  documents: 'document', emails: 'email',
  contracts: 'contract', orders: 'order', entitlements: 'entitlement',
};

// POST /mass-actions/update - Bulk update fields on multiple records
router.post('/update', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds, updates } = req.body;

    if (!module || !MODULE_MAP[module]) {
      return res.status(400).json({ error: `Invalid module. Supported: ${Object.keys(MODULE_MAP).join(', ')}` });
    }
    if (!recordIds || !Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({ error: 'recordIds array required' });
    }
    if (recordIds.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 records per bulk operation' });
    }
    if (!allowed(req, res, module, 'edit')) return;
    const model = MODULE_MAP[module];
    // The model's own columns; owners change through /reassign.
    const data = editableFields(model, updates);
    if (!Object.keys(data).length) {
      return res.status(400).json({ error: 'updates object required' });
    }
    // A link set on every record must name one the caller can see.
    const linkProblem = await linkRefusal(req, model, data);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });

    const where = await reachableWhere(req, module, model, { id: { in: recordIds.map(String) }, ...live(model) }, 'Edit');
    const { done, failed } = isRecordModule(module)
      ? await eachRecord(req, await prisma[model].findMany({ where }), (db, record, ctx) => updateRecord(db, module, record, data, ctx))
      : { done: (await prisma[model].updateMany({ where, data })).count, failed: [] };

    await req.audit({
      action: 'update', module,
      details: `Mass update ${done} ${module}: ${Object.keys(updates).join(', ')}`,
    });

    res.json({ success: true, updated: done, ...(failed.length ? { failed } : {}) });
  } catch (err) { next(err); }
});

// POST /mass-actions/delete - Bulk delete with recycle bin
router.post('/delete', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds } = req.body;

    if (!module || !MODULE_MAP[module]) {
      return res.status(400).json({ error: 'Invalid module' });
    }
    if (!recordIds || !Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({ error: 'recordIds array required' });
    }
    if (recordIds.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 records per bulk operation' });
    }

    if (!allowed(req, res, module, 'full')) return;
    const model = MODULE_MAP[module];

    // Only those the caller may delete, the row access a single DELETE asks for.
    const records = await prisma[model].findMany({
      where: await reachableWhere(req, module, model, { id: { in: recordIds.map(String) }, ...live(model) }, 'Full'),
    });

    // As a single delete is: soft where the model keeps deleted rows, with a
    // recycle bin entry to restore it from. Rows were removed outright,
    // taking their links with them (or failing on them after the bin entries
    // were made), so the bin could not restore them in place.
    let deleted;
    if (isRecordModule(module)) {
      ({ done: deleted } = await eachRecord(req, records, (db, record, ctx) => deleteRecord(db, module, record, ctx)));
    } else {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await Promise.all(records.map(record => prisma.recycleBinItem.create({
        data: { module, recordId: record.id, recordData: record, deletedById: req.userId, expiresAt },
      }).catch(() => {})));
      const ids = records.map(r => r.id);
      deleted = (modelHasField(model, 'deletedAt')
        ? await prisma[model].updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } })
        : await prisma[model].deleteMany({ where: { id: { in: ids } } })).count;
    }

    await req.audit({
      action: 'delete', module,
      details: `Mass deleted ${deleted} ${module}`,
    });

    // One event for the whole action, besides each record's own.
    try {
      const { fireWebhookEvent } = require('../services/webhooks');
      await fireWebhookEvent(prisma, `${module}.bulk_deleted`, { ids: records.map(r => r.id), count: deleted });
    } catch (e) { /* best-effort */ }

    res.json({ success: true, deleted });
  } catch (err) { next(err); }
});

// POST /mass-actions/reassign - Bulk reassign owner
router.post('/reassign', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds, newOwnerId } = req.body;

    if (!module || !MODULE_MAP[module]) {
      return res.status(400).json({ error: 'Invalid module' });
    }
    if (!recordIds || !Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({ error: 'recordIds array required' });
    }
    if (!newOwnerId) {
      return res.status(400).json({ error: 'newOwnerId required' });
    }

    if (!allowed(req, res, module, 'edit')) return;
    if (recordIds.length > 200) return res.status(400).json({ error: 'Maximum 200 records per bulk operation' });

    // Verify new owner exists, and still works here
    const newOwner = await prisma.user.findFirst({ where: { id: String(newOwnerId), active: true, isPortalUser: false }, select: { id: true, firstName: true, lastName: true } });
    if (!newOwner) return res.status(404).json({ error: 'New owner not found' });

    const model = MODULE_MAP[module];

    // The ownership column the model has.
    const ownerField = modelHasField(model, 'ownerId') ? 'ownerId' : modelHasField(model, 'assignedId') ? 'assignedId' : null;
    if (!ownerField) return res.status(400).json({ error: `${module} records have no owner to reassign` });

    const where = await reachableWhere(req, module, model, { id: { in: recordIds.map(String) }, ...live(model) }, 'Edit');
    const change = { [ownerField]: newOwner.id };
    const { done, failed } = isRecordModule(module)
      ? await eachRecord(req, await prisma[model].findMany({ where }), (db, record, ctx) => updateRecord(db, module, record, change, ctx))
      : { done: (await prisma[model].updateMany({ where, data: change })).count, failed: [] };

    await req.audit({
      action: 'update', module,
      details: `Mass reassigned ${done} ${module} to ${newOwner.firstName} ${newOwner.lastName}`,
    });

    res.json({ success: true, reassigned: done, newOwner: `${newOwner.firstName} ${newOwner.lastName}`, ...(failed.length ? { failed } : {}) });
  } catch (err) { next(err); }
});

// POST /mass-actions/tag - Bulk add tag
router.post('/tag', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds, tagId } = req.body;

    if (!module || !Array.isArray(recordIds) || !tagId) {
      return res.status(400).json({ error: 'module, recordIds, and tagId required' });
    }
    if (!MODULE_MAP[module]) return res.status(400).json({ error: 'Invalid module' });
    if (!allowed(req, res, module, 'edit')) return;

    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });

    // Only records the caller may change.
    const model = MODULE_MAP[module];
    const reachable = await prisma[model].findMany({
      where: await reachableWhere(req, module, model, { id: { in: recordIds.slice(0, 200).map(String) } }, 'Edit'),
      select: { id: true },
    });

    let created = 0;
    for (const { id: recordId } of reachable) {
      try {
        await prisma.tagAssignment.create({
          data: { tagId, module, recordId },
        });
        created++;
      } catch (e) {
        // Skip duplicates
      }
    }

    res.json({ success: true, tagged: created });
  } catch (err) { next(err); }
});

// POST /mass-actions/untag - Bulk remove tag
router.post('/untag', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds, tagId } = req.body;

    if (!module || !Array.isArray(recordIds) || !tagId) {
      return res.status(400).json({ error: 'module, recordIds, and tagId required' });
    }
    if (!MODULE_MAP[module]) return res.status(400).json({ error: 'Invalid module' });
    if (!allowed(req, res, module, 'edit')) return;
    const model = MODULE_MAP[module];
    const reachable = await prisma[model].findMany({
      where: await reachableWhere(req, module, model, { id: { in: recordIds.slice(0, 200).map(String) } }, 'Edit'),
      select: { id: true },
    });

    const result = await prisma.tagAssignment.deleteMany({
      where: { tagId, module, recordId: { in: reachable.map(r => r.id) } },
    });

    res.json({ success: true, untagged: result.count });
  } catch (err) { next(err); }
});

// POST /mass-actions/add-to-campaign - Bulk add to campaign
router.post('/add-to-campaign', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { campaignId, contactIds, leadIds } = req.body;

    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    if ((!contactIds || contactIds.length === 0) && (!leadIds || leadIds.length === 0)) {
      return res.status(400).json({ error: 'contactIds or leadIds required' });
    }
    if (!allowed(req, res, 'campaigns', 'edit')) return;
    if (!(await prisma.campaign.findFirst({ where: await reachableWhere(req, 'campaigns', 'campaign', { id: String(campaignId) }, 'Edit'), select: { id: true } }))) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Contacts and leads the caller can see; ids alone used to do.
    const visible = async (module, model, ids) => (Array.isArray(ids) && ids.length && permits(req, module, 'read')
      ? (await prisma[model].findMany({ where: await reachableWhere(req, module, model, { id: { in: ids.slice(0, 500).map(String) } }), select: { id: true } })).map(r => r.id)
      : []);
    const contacts = await visible('contacts', 'contact', contactIds);
    const leads = await visible('leads', 'lead', leadIds);

    // People already on the campaign are skipped here: nothing unique stops a
    // second row, so "skip dupes" never did. Status is left to its default
    // ('pending'), which is what the campaign's own routes write.
    const existing = await prisma.campaignRecipient.findMany({
      where: { campaignId: String(campaignId), OR: [{ contactId: { in: contacts } }, { leadId: { in: leads } }] },
      select: { contactId: true, leadId: true },
    });
    const onCampaign = new Set(existing.flatMap(r => [r.contactId, r.leadId]).filter(Boolean));

    let added = 0;
    const all = [
      ...contacts.filter(id => !onCampaign.has(id)).map(id => ({ campaignId: String(campaignId), contactId: id })),
      ...leads.filter(id => !onCampaign.has(id)).map(id => ({ campaignId: String(campaignId), leadId: id })),
    ];

    for (const data of all) {
      try {
        await prisma.campaignRecipient.create({ data });
        added++;
      } catch (e) { /* skip dupes */ }
    }

    res.json({ success: true, added });
  } catch (err) { next(err); }
});

module.exports = router;
