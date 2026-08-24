const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = Router();
router.use(authenticate);

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

// CREATE tag
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const tag = await prisma.tag.create({ data: { name: req.body.name, color: req.body.color } });
    res.status(201).json(tag);
  } catch (err) { next(err); }
});

// UPDATE tag
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const tag = await prisma.tag.update({ where: { id: req.params.id }, data: req.body });
    res.json(tag);
  } catch (err) { next(err); }
});

// DELETE tag
router.delete('/:id', async (req, res, next) => {
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
    await prisma.tagAssignment.deleteMany({ where: { tagId, module, recordId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// BULK assign tags
router.post('/bulk-assign', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { tagIds, module, recordIds } = req.body;
    const data = [];
    for (const tagId of tagIds) {
      for (const recordId of recordIds) {
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
    const assignments = await prisma.tagAssignment.findMany({
      where: { module: req.params.module, tagId: req.params.tagId },
      select: { recordId: true },
    });
    res.json({ data: assignments.map(a => a.recordId) });
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
    if (!tagIds?.length || !recordIds?.length) return res.status(400).json({ error: 'tagIds and recordIds required' });
    let assigned = 0;
    for (const tagId of tagIds) {
      for (const recordId of recordIds) {
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
