const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { canReach, reachableWhere } = require('../middleware/access');
const { crudModelFor } = require('../utils/crud');
const { columnsFrom, scalarOrderBy } = require('../utils/modelFields');

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

/** Of `ids`, the tags that exist and have not been merged away (soft-deleted). */
async function liveTagIds(prisma, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))];
  const found = await prisma.tag.findMany({ where: { id: { in: wanted }, deletedAt: null }, select: { id: true } });
  return found.map(t => t.id);
}

/**
 * Tag id -> how many live records carrying it the caller can see, in modules
 * they may read. Usage counted every assignment, so a tag's count told anyone
 * signed in about records in modules and rows they cannot open.
 */
async function visibleUsage(req, where = {}) {
  const byModule = new Map(); // module -> assignments
  for (const a of await req.app.locals.prisma.tagAssignment.findMany({ where, select: { tagId: true, module: true, recordId: true } })) {
    if (!byModule.has(a.module)) byModule.set(a.module, []);
    byModule.get(a.module).push(a);
  }
  const counts = new Map();
  for (const [module, assignments] of byModule) {
    const modelName = crudModelFor(module);
    if (!modelName || !permits(req, module, 'read')) continue;
    const visible = await reachableIds(req, module, modelName, [...new Set(assignments.map(a => a.recordId))], 'Read');
    for (const a of assignments) if (visible.has(a.recordId)) counts.set(a.tagId, (counts.get(a.tagId) || 0) + 1);
  }
  return counts;
}

// LIST all tags
// Tag names are for anyone signed in; the usage count is of the records the
// caller can see (see visibleUsage). Live tags only, a page at a time and
// searchable by name: tags merged away came back here, and the Tags page's
// search and paging did nothing.
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { search, page = 1, limit = 50, sortBy, sortDir } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const current = Math.max(parseInt(page) || 1, 1);
    const where = { deletedAt: null, ...(search ? { name: { contains: String(search), mode: 'insensitive' } } : {}) };
    const [tags, total, usage] = await Promise.all([
      prisma.tag.findMany({ where, orderBy: scalarOrderBy('tag', sortBy, sortDir) || { name: 'asc' }, skip: (current - 1) * take, take }),
      prisma.tag.count({ where }),
      visibleUsage(req),
    ]);
    res.json({
      data: tags.map(t => ({ ...t, usageCount: usage.get(t.id) || 0 })),
      meta: { total, page: current, limit: take, pages: Math.ceil(total / take) },
    });
  } catch (err) { next(err); }
});

// Tag definitions are shared settings; deleting one removes it from every record.

// CREATE tag
router.post('/', requirePermission('settings', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.body.name?.trim?.()) return res.status(400).json({ error: 'name required' });
    const tag = await prisma.tag.create({ data: { name: req.body.name, color: req.body.color } });
    res.status(201).json(tag);
  } catch (err) { next(err); }
});

// UPDATE tag
router.put('/:id', requirePermission('settings', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const tag = await prisma.tag.update({ where: { id: req.params.id }, data: columnsFrom('tag', req.body) });
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
      where: { module: req.params.module, recordId: req.params.recordId, tag: { deletedAt: null } },
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
    // A live tag: an unknown id failed on the foreign key (500), and a merged one was reattached.
    const [liveTag] = await liveTagIds(prisma, [tagId]);
    if (!liveTag) return res.status(404).json({ error: 'Tag not found' });
    const assignment = await prisma.tagAssignment.create({
      data: { tagId: liveTag, module, recordId },
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
    // Only the records the caller may change, and live tags.
    const editable = await reachableIds(req, module, modelName, recordIds, 'Edit');
    const data = [];
    for (const tagId of await liveTagIds(prisma, tagIds)) {
      for (const recordId of editable) {
        data.push({ tagId, module, recordId });
      }
    }
    // Those actually added: pairs already tagged are skipped, and were counted.
    const { count } = await prisma.tagAssignment.createMany({ data, skipDuplicates: true });
    res.json({ success: true, assigned: count });
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
// Counted every tagged record, in every module, for anyone signed in; now the
// records the caller can see (see visibleUsage).
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [tags, usage] = await Promise.all([prisma.tag.findMany({ where: { deletedAt: null } }), visibleUsage(req)]);
    const stats = tags.map(tag => ({ id: tag.id, name: tag.name, color: tag.color, usageCount: usage.get(tag.id) || 0 }));
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
    if (!targetTagId || !Array.isArray(sourceTagIds) || !sourceTagIds.length) return res.status(400).json({ error: 'targetTagId and sourceTagIds required' });
    const [target] = await liveTagIds(prisma, [targetTagId]);
    if (!target) return res.status(404).json({ error: 'Target tag not found' });
    // A record that already carries the target loses the source tag rather
    // than having it moved. Moving it broke the unique (tag, record) key, the
    // error was swallowed, and the source tag was deleted with its records
    // still on it. The target is never merged into itself (that deleted it).
    const onTarget = new Set((await prisma.tagAssignment.findMany({ where: { tagId: target }, select: { module: true, recordId: true } }))
      .map(a => `${a.module}:${a.recordId}`));
    for (const sourceId of [...new Set(sourceTagIds.map(String))].filter(id => id !== target)) {
      const assignments = await prisma.tagAssignment.findMany({ where: { tagId: sourceId }, select: { id: true, module: true, recordId: true } });
      const clashing = assignments.filter(a => onTarget.has(`${a.module}:${a.recordId}`)).map(a => a.id);
      if (clashing.length) await prisma.tagAssignment.deleteMany({ where: { id: { in: clashing } } });
      await prisma.tagAssignment.updateMany({ where: { tagId: sourceId }, data: { tagId: target } });
      assignments.forEach(a => onTarget.add(`${a.module}:${a.recordId}`));
      await prisma.tag.update({ where: { id: sourceId }, data: { deletedAt: new Date() } }).catch(() => {});
    }
    res.json({ message: 'Tags merged', targetTagId: target });
  } catch (err) { next(err); }
});

// GET one tag, as the list shows it, for anyone signed in as the list is: the
// Tags page opens a tag by URL with this, and there was no such route.
// Registered after /stats, which "/:id" would otherwise take.
router.get('/:id', async (req, res, next) => {
  try {
    const tag = await req.app.locals.prisma.tag.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!tag) return res.status(404).json({ error: 'Not found' });
    const usage = await visibleUsage(req, { tagId: tag.id });
    res.json({ ...tag, usageCount: usage.get(tag.id) || 0 });
  } catch (err) { next(err); }
});
