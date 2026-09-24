const { Router } = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { summaryRoute } = require('../utils/moduleStatus');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760 } });

const router = createCrudRouter('document', 'documents', {
  include: {
    contact: { select: { id: true, firstName: true, lastName: true } },
    deal: { select: { id: true, name: true } },
    account: { select: { id: true, name: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
    ],
  }),
  // The file columns describe the stored upload, and only the upload routes
  // set them. Taken from a request body, filePath named any file on the
  // server for /:id/download to send.
  serverFields: ['filePath', 'fileSize', 'mimeType'],
});

// File upload
router.post('/upload', authenticate, requirePermission('documents', 'edit'), auditMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Only on records the caller can see. The keys were stored as sent, so a
    // file could be filed on anyone's deal, account or contact. Multer has
    // already saved it, so a refused upload is removed.
    const linkProblem = await linkRefusal(req, 'document', { dealId: req.body.dealId, accountId: req.body.accountId, contactId: req.body.contactId });
    if (linkProblem) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    }
    const doc = await prisma.document.create({
      data: {
        name: req.body.name || req.file.originalname, fileName: req.file.filename,
        category: req.body.category || 'General', mimeType: req.file.mimetype,
        fileSize: req.file.size, filePath: req.file.path,
        ...(req.body.dealId && { dealId: req.body.dealId }),
        ...(req.body.accountId && { accountId: req.body.accountId }),
        ...(req.body.contactId && { contactId: req.body.contactId }),
        createdById: req.user.id,
      },
    });
    await req.audit({ action: 'create', module: 'documents', recordId: doc.id, details: `File uploaded: ${req.file.originalname}` });
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

// Bulk upload
router.post('/upload/bulk', authenticate, requirePermission('documents', 'edit'), auditMiddleware, upload.array('files', 20), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.files?.length) return res.status(400).json({ error: 'No files' });
    const docs = await prisma.$transaction(req.files.map(file =>
      prisma.document.create({
        data: {
          name: file.originalname, fileName: file.filename, mimeType: file.mimetype,
          fileSize: file.size, filePath: file.path, category: req.body.category || 'General',
          createdById: req.user.id,
        },
      })
    ));
    res.status(201).json({ uploaded: docs.length, documents: docs });
  } catch (err) { next(err); }
});

// Download
router.get('/:id/download', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    // Only a file inside the upload directory, where multer writes them. A
    // stored filePath could name any file the server can read (.env, keys).
    const base = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const full = path.resolve(doc.filePath || '');
    if (!doc.filePath || !(full === base || full.startsWith(base + path.sep))) {
      return res.status(404).json({ error: 'Document not found' });
    }
    await prisma.document.update({ where: { id: req.params.id }, data: { downloadCount: (doc.downloadCount || 0) + 1 } });
    res.download(full, doc.fileName);
  } catch (err) { next(err); }
});

// Version upload (new version of existing document)
router.post('/:id/version', authenticate, requirePermission('documents', 'edit'), upload.single('file'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const original = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Document not found' });
    const doc = await prisma.document.update({
      where: { id: req.params.id },
      data: {
        fileName: req.file.filename, mimeType: req.file.mimetype,
        fileSize: req.file.size, filePath: req.file.path,
        version: (original.version || 1) + 1, updatedAt: new Date(),
      },
    });
    res.json(doc);
  } catch (err) { next(err); }
});

// Search by category
router.get('/category/:category', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Only documents the caller may see; this listed every one.
    const docs = await prisma.document.findMany({
      where: await reachableWhere(req, 'documents', 'document', { category: req.params.category }),
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  } catch (err) { next(err); }
});

module.exports = router;

// Document sharing. The router has checked the caller can edit this
// document, so a share hands out view or edit and nothing above that.
const SHARE_LEVELS = ['view', 'edit'];
router.post('/:id/share', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { shareWith } = req.body;
    const access = req.body.access || 'view';
    if (!SHARE_LEVELS.includes(access)) return res.status(400).json({ error: `access must be one of: ${SHARE_LEVELS.join(', ')}` });
    const updated = await prisma.document.update({ where: { id: req.params.id }, data: { sharedWith: shareWith, accessLevel: access } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Document templates
router.get('/templates/list', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Only templates the caller may see; this listed every one.
    const templates = await prisma.document.findMany({ where: await reachableWhere(req, 'documents', 'document', { isTemplate: true }), orderBy: { name: 'asc' } });
    res.json(templates);
  } catch (err) { next(err); }
});

// Clone from template
router.post('/from-template/:templateId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The router checks a param named `id`, not this one, so any document
    // (its file included) could be copied by id and then downloaded.
    const template = await prisma.document.findFirst({ where: await reachableWhere(req, 'documents', 'document', { id: req.params.templateId }) });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const { id, createdAt, updatedAt, ...data } = template;
    // Prisma refuses a bare null for a Json column; left out, it stays NULL.
    if (data.sharedWith === null) delete data.sharedWith;
    const doc = await prisma.document.create({ data: { ...data, name: req.body.name || `${template.name} (Copy)`, isTemplate: false, createdById: req.user.id } });
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'documents', model: 'document' });
