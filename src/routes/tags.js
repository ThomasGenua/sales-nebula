const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { canReach, reachableWhere } = require('../middleware/access');
const { crudModelFor } = require('../utils/crud');
const { pickModelFields } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

/**
 * The model behind a record module the caller holds `level` on, or null once
 * it has answered. Tagging took any module and record id with a session
 * alone, so anyone could tag, untag or list the tags of any record.
 */
function taggableModel(req, res, module, level) {
  const modelName = typeof module === 'string' ? crudModelFor(module) : null;
  if (!modelName) { res.status(400).json({ error: `Tags are not available for ${module}` }); return null; }
  if (!permits(req, module, level)) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return null; }
  return modelName;
}

/** Of `recordIds`, those the caller may see (minLevel 'Read') or change ('Edit'). */
async function reachableIds(req, module, modelName, recordIds, minLevel) {
  const found = await req.app.locals.prisma[modelName].findMany({
    where: await reachableWhere(req, module, modelName, { id: { in: recordIds.map(String) } }, minLevel),
    select: { id: true },
  });
  return new Set(found.map(r => r.id));
}

// LIST all tags
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const tags = await prisma.tag.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
    res.json({ data: tags.map(t => ({ ...t, usageCount: t._count.assignments })) });
  } catch (err) { next(err); }
});

// Tag definitions are shared settings; deleting one removes it from every record.

// CREATE tag
router.post('/', requirePermission('settings', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const tag = await prisma.tag.create({ data: { name: req.body.name, color: req.body.color } });
    res.status(201).json(tag);
  } catch (err) { next(err); }
});

// UPDATE tag
router.put('/:id', requirePermission('settings', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, updatedAt, ...rest } = req.body || {};
    const tag = await prisma.tag.update({ where: { id: req.params.id }, data: pickModelFields('tag', rest).data });
    res.json(tag);
  } catch (err) { next(err); }
});

// DELETE tag
router.delete('/:id', requirePermission('settings', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.tag.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET tags for a specific record
router.get('/record/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const modelName = taggableModel(req, res, req.params.module, 'read');
    if (!modelName) return;
    if (!(await canReach(req, req.params.module, modelName, req.params.recordId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const assignments = await prisma.tagAssignment.findMany({
      where: { module: req.params.module, recordId: req.params.recordId },
      include: { tag: true },
    });
    res.json({ data: assignments.map(a => a.tag) });
  } catch (err) { next(err); }
});

// ASSIGN tag to record
router.post('/assign', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { tagId, module, recordId } = req.body;
    const modelName = taggableModel(req, res, module, 'edit');
    if (!modelName) return;
    if (!(await canReach(req, module, modelName, recordId, 'Edit'))) return res.status(404).json({ error: 'Not found' });
    const assignment = await prisma.tagAssignment.create({
      data: { tagId, module, recordId },
      include: { tag: true },
    });
    res.status(201).json(assignment);
  } catch (err) { next(err); }
});

// REMOVE tag from record
router.delete('/assign/:module/:recordId/:tagId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, tagId } = req.params;
    const modelName = taggableModel(req, res, module, 'edit');
    if (!modelName) return;
    if (!(await canReach(req, module, modelName, recordId, 'Edit'))) return res.status(404).json({ error: 'Not found' });
    await prisma.tagAssignment.deleteMany({ where: { tagId, module, recordId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// BULK assign tags
router.post('/bulk-assign', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { tagIds, module, recordIds } = req.body;
    if (!Array.isArray(tagIds) || !Array.isArray(recordIds)) return res.status(400).json({ error: 'tagIds and recordIds required' });
    const modelName = taggableModel(req, res, module, 'edit');
    if (!modelName) return;
    // Only the records the caller may change.
    const editable = await reachableIds(req, module, modelName, recordIds, 'Edit');
    const data = [];
    for (const tagId of tagIds) {
      for (const recordId of editable) {
        data.push({ tagId, module, recordId });
      }
    }
    await prisma.tagAssignment.createMany({ data, skipDuplicates: true });
    res.json({ success: true, assigned: data.length });
  } catch (err) { next(err); }
});

// SEARCH records by tag
router.get('/search/:module/:tagId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const modelName = taggableModel(req, res, req.params.module, 'read');
    if (!modelName) return;
    const assignments = await prisma.tagAssignment.findMany({
      where: { module: req.params.module, tagId: req.params.tagId },
      select: { recordId: true },
    });
    // Only the records the caller can see.
    const visible = await reachableIds(req, req.params.module, modelName, assignments.map(a => a.recordId), 'Read');
    res.json({ data: assignments.map(a => a.recordId).filter(id => visible.has(id)) });
  } catch (err) { next(err); }
});

module.exports = router;

// Tag usage stats
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const tags = await prisma.tag.findMany({ where: { deletedAt: null } });
    const stats = [];
    for (const tag of tags) {
      const count = await prisma.tagAssignment.count({ where: { tagId: tag.id } }).catch(() => 0);
      stats.push({ id: tag.id, name: tag.name, color: tag.color, usageCount: count });
    }
    stats.sort((a, b) => b.usageCount - a.usageCount);
    res.json(stats);
  } catch (err) { next(err); }
});

// Bulk tag assignment
router.post('/bulk-assign', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { tagIds, recordIds, module } = req.body;
    if (!Array.isArray(tagIds) || !tagIds.length || !Array.isArray(recordIds) || !recordIds.length) return res.status(400).json({ error: 'tagIds and recordIds required' });
    // Shadowed by the route of the same path above; guarded the same way.
    const modelName = taggableModel(req, res, module, 'edit');
    if (!modelName) return;
    const editable = await reachableIds(req, module, modelName, recordIds, 'Edit');
    let assigned = 0;
    for (const tagId of tagIds) {
      for (const recordId of editable) {
        try { await prisma.tagAssignment.create({ data: { tagId, recordId, module } }); assigned++; } catch (e) {}
      }
    }
    res.json({ assigned });
  } catch (err) { next(err); }
});

// Merge tags
router.post('/merge', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { targetTagId, sourceTagIds } = req.body;
    if (!targetTagId || !sourceTagIds?.length) return res.status(400).json({ error: 'targetTagId and sourceTagIds required' });
    for (const sourceId of sourceTagIds) {
      await prisma.tagAssignment.updateMany({ where: { tagId: sourceId }, data: { tagId: targetTagId } }).catch(() => {});
      await prisma.tag.update({ where: { id: sourceId }, data: { deletedAt: new Date() } }).catch(() => {});
    }
    res.json({ message: 'Tags merged', targetTagId });
  } catch (err) { next(err); }
});
