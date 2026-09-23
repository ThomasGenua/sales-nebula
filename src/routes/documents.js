const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
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
});

// File upload
router.post('/upload', authenticate, requirePermission('documents', 'edit'), auditMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
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
    await prisma.document.update({ where: { id: req.params.id }, data: { downloadCount: (doc.downloadCount || 0) + 1 } });
    res.download(doc.filePath, doc.fileName);
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
    const docs = await prisma.document.findMany({
      where: { category: req.params.category, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  } catch (err) { next(err); }
});

module.exports = router;

// Document sharing
router.post('/:id/share', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { shareWith, access } = req.body;
    const updated = await prisma.document.update({ where: { id: req.params.id }, data: { sharedWith: shareWith, accessLevel: access || 'view' } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Document templates
router.get('/templates/list', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const templates = await prisma.document.findMany({ where: { isTemplate: true, deletedAt: null }, orderBy: { name: 'asc' } });
    res.json(templates);
  } catch (err) { next(err); }
});

// Clone from template
router.post('/from-template/:templateId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.document.findUnique({ where: { id: req.params.templateId } });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const { id, createdAt, updatedAt, ...data } = template;
    const doc = await prisma.document.create({ data: { ...data, name: req.body.name || `${template.name} (Copy)`, isTemplate: false, createdById: req.user.id } });
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'documents', model: 'document' });

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "documents" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'documents', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
