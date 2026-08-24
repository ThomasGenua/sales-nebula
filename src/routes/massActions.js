const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

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
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'updates object required' });
    }

    const model = MODULE_MAP[module];
    const result = await prisma[model].updateMany({
      where: { id: { in: recordIds } },
      data: updates,
    });

    await req.audit({
      action: 'update', module,
      details: `Mass update ${result.count} ${module}: ${Object.keys(updates).join(', ')}`,
    });

    res.json({ success: true, updated: result.count });
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

    const model = MODULE_MAP[module];

    // Snapshot records for recycle bin
    const records = await prisma[model].findMany({
      where: { id: { in: recordIds } },
    });

    // Move to recycle bin
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await Promise.all(records.map(record =>
      prisma.recycleBinItem.create({
        data: {
          module, recordId: record.id,
          recordData: record,
          deletedById: req.userId,
          expiresAt,
        },
      }).catch(() => {})
    ));

    // Delete records
    const result = await prisma[model].deleteMany({
      where: { id: { in: recordIds } },
    });

    await req.audit({
      action: 'delete', module,
      details: `Mass deleted ${result.count} ${module}`,
    });

    // Fire webhooks
    try {
      const { fireWebhookEvent } = require('../services/webhooks');
      await fireWebhookEvent(prisma, `${module}.bulk_deleted`, { ids: recordIds, count: result.count });
    } catch (e) { /* best-effort */ }

    res.json({ success: true, deleted: result.count });
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

    // Verify new owner exists
    const newOwner = await prisma.user.findUnique({ where: { id: newOwnerId }, select: { id: true, firstName: true, lastName: true } });
    if (!newOwner) return res.status(404).json({ error: 'New owner not found' });

    const model = MODULE_MAP[module];

    // Determine owner field name
    const ownerField = ['leads', 'cases'].includes(module) ? 'assignedId' : 'ownerId';

    const result = await prisma[model].updateMany({
      where: { id: { in: recordIds } },
      data: { [ownerField]: newOwnerId },
    });

    await req.audit({
      action: 'update', module,
      details: `Mass reassigned ${result.count} ${module} to ${newOwner.firstName} ${newOwner.lastName}`,
    });

    res.json({ success: true, reassigned: result.count, newOwner: `${newOwner.firstName} ${newOwner.lastName}` });
  } catch (err) { next(err); }
});

// POST /mass-actions/tag - Bulk add tag
router.post('/tag', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds, tagId } = req.body;

    if (!module || !recordIds || !tagId) {
      return res.status(400).json({ error: 'module, recordIds, and tagId required' });
    }

    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });

    let created = 0;
    for (const recordId of recordIds) {
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

    if (!module || !recordIds || !tagId) {
      return res.status(400).json({ error: 'module, recordIds, and tagId required' });
    }

    const result = await prisma.tagAssignment.deleteMany({
      where: { tagId, module, recordId: { in: recordIds } },
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

    let added = 0;
    const all = [
      ...(contactIds || []).map(id => ({ campaignId, contactId: id, status: 'Pending' })),
      ...(leadIds || []).map(id => ({ campaignId, leadId: id, status: 'Pending' })),
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
