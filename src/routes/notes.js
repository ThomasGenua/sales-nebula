const { Router } = require('express');
const { auditMiddleware } = require("../middleware/audit");
const { authenticate, permits } = require('../middleware/auth');
const { canReach, reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');
const { scalarOrderBy } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

const AUTHOR = { id: true, firstName: true, lastName: true, avatar: true };

/**
 * Whether the caller may read the notes on a record: the module's read
 * permission, and a record they can see. Otherwise answers and returns false.
 * These listed the notes on any record id for anyone signed in.
 */
async function readableRecord(req, res, module, recordId) {
  const modelName = crudModelFor(module);
  if (!modelName) { res.status(400).json({ error: `Notes are not available for ${module}` }); return false; }
  if (!permits(req, module, 'read')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return false; }
  if (!(await canReach(req, module, modelName, recordId))) { res.status(404).json({ error: 'Not found' }); return false; }
  return true;
}

/** Whether the caller may change a record: module edit and Edit reach. */
async function editableRecord(req, module, recordId) {
  const modelName = crudModelFor(module);
  return !!modelName && permits(req, module, 'edit') && canReach(req, module, modelName, recordId, 'Edit');
}

/** The notes the caller wrote, or that sit on records they may read. */
async function readableNotes(req, notes) {
  if (isAdmin(req.user)) return notes;
  const prisma = req.app.locals.prisma;
  const others = new Map(); // module -> record ids
  for (const n of notes) {
    if (n.authorId === req.userId) continue;
    if (!others.has(n.module)) others.set(n.module, new Set());
    others.get(n.module).add(n.recordId);
  }
  const readable = new Set();
  for (const [module, ids] of others) {
    const modelName = crudModelFor(module);
    if (!modelName || !permits(req, module, 'read')) continue;
    const rows = await prisma[modelName].findMany({ where: await reachableWhere(req, module, modelName, { id: { in: [...ids] } }), select: { id: true } });
    rows.forEach(r => readable.add(`${module}:${r.id}`));
  }
  return notes.filter(n => n.authorId === req.userId || readable.has(`${n.module}:${n.recordId}`));
}

/**
 * `where`, narrowed to the live notes readableNotes would keep, so a list can
 * page and count in the database: each record other people's notes sit on is
 * judged once, as readableNotes judges it.
 */
async function readableNotesWhere(req, where = {}) {
  const live = { AND: [where, { deletedAt: null }] };
  if (isAdmin(req.user)) return live;
  const records = await req.app.locals.prisma.note.findMany({
    where: { AND: [live, { authorId: { not: req.userId } }] },
    distinct: ['module', 'recordId'], select: { module: true, recordId: true },
  });
  const byModule = new Map(); // module -> readable record ids
  for (const r of await readableNotes(req, records.map(r => ({ ...r, authorId: null })))) {
    if (!byModule.has(r.module)) byModule.set(r.module, []);
    byModule.get(r.module).push(r.recordId);
  }
  const onReadable = [...byModule].map(([module, ids]) => ({ module, recordId: { in: ids } }));
  return { AND: [live, { OR: [{ authorId: req.userId }, ...onReadable] }] };
}

/** Notes with their authors' names, as a record's notes are listed. */
async function withAuthors(prisma, notes) {
  const authorIds = [...new Set(notes.map(n => n.authorId))];
  const authors = await prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR });
  const authorMap = Object.fromEntries(authors.map(a => [a.id, a]));
  return notes.map(n => ({ ...n, author: authorMap[n.authorId] || null }));
}

/**
 * File a note, by the caller, on a live record they can see, and answer 201
 * with it; otherwise answer why not. POST / and POST /:module/:recordId both
 * create through this. The Notes page sends a title as well as the body, and
 * a note has only a body, so a title leads it rather than being dropped.
 */
async function createNote(req, res, module, recordId) {
  const prisma = req.app.locals.prisma;
  const body = [req.body.title, req.body.body].filter(v => typeof v === 'string' && v.trim()).join('\n\n');
  if (!body) return res.status(400).json({ error: 'body required' });
  if (!(await readableRecord(req, res, module, recordId))) return;
  // canReach passes any id in a module nothing restricts; a note must name a record that exists.
  const modelName = crudModelFor(module);
  if (!(await prisma[modelName].findFirst({ where: await reachableWhere(req, module, modelName, { id: String(recordId) }), select: { id: true } }))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const note = await prisma.note.create({
    data: {
      body,
      pinned: req.body.pinned === true,
      module,
      recordId: String(recordId),
      authorId: req.userId,
    },
  });
  const author = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR });
  res.status(201).json({ ...note, author });
}

// LIST notes: the Notes page. The caller's own and those on records they can
// see (readableNotesWhere), a page at a time. There was no list, so the page
// never loaded.
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { search, module, page = 1, limit = 50, sortBy, sortDir } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const current = Math.max(parseInt(page) || 1, 1);
    const where = await readableNotesWhere(req, {
      ...(search ? { body: { contains: String(search), mode: 'insensitive' } } : {}),
      ...(module ? { module: String(module) } : {}),
    });
    const [notes, total] = await Promise.all([
      prisma.note.findMany({
        where, skip: (current - 1) * take, take,
        orderBy: scalarOrderBy('note', sortBy, sortDir) || [{ pinned: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.note.count({ where }),
    ]);
    res.json({ data: await withAuthors(prisma, notes), meta: { total, page: current, limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

// CREATE note from the Notes page, which names the record in the body.
router.post('/', async (req, res, next) => {
  try {
    const { module, recordId } = req.body;
    if (!module || !recordId) return res.status(400).json({ error: 'module and recordId required' });
    await createNote(req, res, String(module), recordId);
  } catch (err) { next(err); }
});

// UPDATE note
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.note.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.authorId !== req.userId) return res.status(403).json({ error: 'Can only edit your own notes' });

    const note = await prisma.note.update({
      where: { id: req.params.id },
      data: { body: req.body.body, pinned: req.body.pinned },
    });
    res.json(note);
  } catch (err) { next(err); }
});

// DELETE note
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.note.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.authorId !== req.userId) return res.status(403).json({ error: 'Can only delete your own notes' });

    await prisma.note.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PIN/UNPIN note
router.post('/:id/pin', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const note = await prisma.note.findUnique({ where: { id: req.params.id } });
    if (!note) return res.status(404).json({ error: 'Not found' });
    // Pinning reorders a record's notes for everyone who reads them, so it is
    // the author's, or for someone who may change the record. Anyone signed
    // in pinned any note by id.
    if (note.authorId !== req.userId && !isAdmin(req.user) && !(await editableRecord(req, note.module, note.recordId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const updated = await prisma.note.update({
      where: { id: req.params.id },
      data: { pinned: !note.pinned },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;

// Pin/unpin note

// Notes for a parent record
router.get('/parent/:module/:parentId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, parentId } = req.params;
    if (!(await readableRecord(req, res, module, parentId))) return;
    const notes = await prisma.note.findMany({
      // A note names its record by module + recordId.
      where: { module, recordId: parentId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], take: 50,
    });
    res.json(notes);
  } catch (err) { next(err); }
});

// Search notes
// Searched every note on every record for anyone signed in. It now finds the
// caller's own notes and notes on records they can see, from the most recent
// matches. A note has no title or parentModule, so this failed on every call.
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, module } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const matches = await prisma.note.findMany({
      where: { deletedAt: null, body: { contains: q, mode: 'insensitive' }, ...(module ? { module } : {}) },
      orderBy: { createdAt: 'desc' }, take: 250,
    });
    const notes = (await readableNotes(req, matches)).slice(0, 25);
    res.json({ results: notes, count: notes.length });
  } catch (err) { next(err); }
});

// Bulk delete notes
// Deleted anyone's notes by id; now the caller's own, unless an admin.
router.post('/bulk/delete', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });
    const result = await prisma.note.updateMany({ where: { id: { in: ids }, ...(isAdmin(req.user) ? {} : { authorId: req.userId }) }, data: { deletedAt: new Date() } });
    res.json({ deleted: result.count });
  } catch (err) { next(err); }
});

// Totals of the notes the list shows. The shared summary counted every note,
// on records the caller cannot see included, as notes have no row security.
router.get('/analytics/summary', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const since = new Date(Date.now() - 30 * 86400000);
    const [total, recent] = await Promise.all([
      prisma.note.count({ where: await readableNotesWhere(req) }),
      prisma.note.count({ where: await readableNotesWhere(req, { createdAt: { gte: since } }) }),
    ]);
    res.json({ module: 'notes', total, createdLast30Days: recent, checkedAt: new Date() });
  } catch (err) { next(err); }
});

// GET one note, when the list would show it. After the one-segment literal
// routes (/search), which "/:id" would otherwise take.
router.get('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const note = await prisma.note.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!note || !(await readableNotes(req, [note])).length) return res.status(404).json({ error: 'Not found' });
    res.json((await withAuthors(prisma, [note]))[0]);
  } catch (err) { next(err); }
});

/**
 * Catch-all record routes, registered last on purpose.
 *
 * Express matches in order, and "/:module/:recordId" is two segments — the
 * same shape as /notes/:id/pin, /notes/bulk/delete, /notes/bulk/status and
 * /notes/analytics/summary. While it sat at the top of this file it swallowed
 * all four: pinning a note ran the create handler instead, which threw
 * "Argument `body` is missing" because a pin request carries no body.
 */
// GET notes for a record
router.get('/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    if (!(await readableRecord(req, res, module, recordId))) return;
    const notes = await prisma.note.findMany({
      // Live notes only: ones bulk-deleted (soft) came back with the rest.
      where: { module, recordId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({ data: await withAuthors(prisma, notes) });
  } catch (err) { next(err); }
});

// CREATE note
// On a record the caller can see; this took any module and record id.
router.post('/:module/:recordId', async (req, res, next) => {
  try {
    await createNote(req, res, req.params.module, req.params.recordId);
  } catch (err) { next(err); }
});
