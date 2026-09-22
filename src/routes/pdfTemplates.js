const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const {
  render, buildDocument, buildContext, validateTemplate,
  extractMergeFields, FORMATTERS, STARTER_TEMPLATES,
} = require('../utils/mergeFields');

const router = Router();

const TEMPLATE_MODULES = ['quotes', 'invoices', 'contracts', 'orders', 'cases', 'accounts', 'contacts', 'deals', 'projects'];

const MODEL_FOR = {
  quotes: 'quote', invoices: 'invoice', contracts: 'contract', orders: 'order',
  cases: 'case', accounts: 'account', contacts: 'contact', deals: 'deal', projects: 'project',
};

/**
 * Load a record plus the related records templates usually reference,
 * so {{account.name}} resolves from a quote without extra config.
 */
async function loadRenderData(prisma, module, recordId) {
  const model = MODEL_FOR[module];
  if (!model) return null;

  const record = await prisma[model].findFirst({ where: { id: recordId, deletedAt: null } });
  if (!record) return null;

  const related = {};
  const safeFind = async (name, fn) => { try { const r = await fn(); if (r) related[name] = r; } catch { /* relation may not exist */ } };

  if (record.accountId) await safeFind('account', () => prisma.account.findUnique({ where: { id: record.accountId } }));
  if (record.contactId) await safeFind('contact', () => prisma.contact.findUnique({ where: { id: record.contactId } }));
  if (record.dealId) await safeFind('deal', () => prisma.deal.findUnique({ where: { id: record.dealId } }));
  if (record.ownerId) await safeFind('owner', () => prisma.user.findUnique({ where: { id: record.ownerId }, select: { id: true, firstName: true, lastName: true, email: true, phone: true, title: true } }));

  // Line items live on different models per document type
  const lineItemModels = { quotes: 'quoteLineItem', invoices: 'invoiceLineItem', orders: 'orderLineItem', contracts: 'contractLineItem' };
  const lim = lineItemModels[module];
  if (lim) {
    const key = `${MODEL_FOR[module]}Id`;
    await safeFind('lineItems', () => prisma[lim].findMany({ where: { [key]: record.id }, orderBy: { sortOrder: 'asc' } }));
  }

  return { record, related };
}

// ── TEMPLATES ─────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, active, search, page = 1, limit = 50 } = req.query;
    const where = { deletedAt: null };
    if (module) where.module = module;
    if (active !== undefined) where.active = active === 'true';
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];

    const [data, total] = await Promise.all([
      prisma.pdfTemplate.findMany({
        where, skip: (+page - 1) * +limit, take: +limit,
        orderBy: [{ isDefault: 'desc' }, { usageCount: 'desc' }],
        select: { id: true, name: true, description: true, module: true, templateType: true, isDefault: true, active: true, usageCount: true, lastUsedAt: true, pageSize: true, orientation: true, updatedAt: true },
      }),
      prisma.pdfTemplate.count({ where }),
    ]);
    res.json({ data, total, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.pdfTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const validation = validateTemplate(template.bodyHtml);
    res.json({ ...template, mergeFields: validation.fields, validation: { valid: validation.valid, errors: validation.errors, warnings: validation.warnings } });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, bodyHtml, description, headerHtml, footerHtml, css, pageSize, orientation, isDefault, templateType, locale } = req.body;

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!module || !TEMPLATE_MODULES.includes(module)) {
      return res.status(400).json({ error: `module must be one of: ${TEMPLATE_MODULES.join(', ')}` });
    }
    if (!bodyHtml) return res.status(400).json({ error: 'bodyHtml required' });

    const validation = validateTemplate(bodyHtml);
    if (!validation.valid) return res.status(400).json({ error: 'Template syntax is invalid', errors: validation.errors });

    if (isDefault) {
      await prisma.pdfTemplate.updateMany({ where: { module, isDefault: true }, data: { isDefault: false } });
    }

    const template = await prisma.pdfTemplate.create({
      data: {
        name, module, bodyHtml, description, headerHtml, footerHtml, css,
        pageSize: pageSize || 'A4', orientation: orientation || 'portrait',
        isDefault: !!isDefault, templateType: templateType || 'Document',
        locale: locale || 'en', createdById: req.user.id,
      },
    });

    await req.audit({ action: 'create', module: 'pdfTemplates', recordId: template.id, details: `PDF template created: ${name}` });
    res.status(201).json({ ...template, mergeFields: validation.fields, warnings: validation.warnings });
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, renders, mergeFields, validation: _v, ...data } = req.body;

    if (data.bodyHtml) {
      const v = validateTemplate(data.bodyHtml);
      if (!v.valid) return res.status(400).json({ error: 'Template syntax is invalid', errors: v.errors });
    }
    if (data.module && !TEMPLATE_MODULES.includes(data.module)) {
      return res.status(400).json({ error: `Unsupported module: ${data.module}` });
    }

    const existing = await prisma.pdfTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    if (data.isDefault) {
      await prisma.pdfTemplate.updateMany({ where: { module: data.module || existing.module, isDefault: true, id: { not: existing.id } }, data: { isDefault: false } });
    }

    const template = await prisma.pdfTemplate.update({ where: { id: existing.id }, data });
    await req.audit({ action: 'update', module: 'pdfTemplates', recordId: template.id, details: `PDF template updated: ${template.name}` });
    res.json(template);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.pdfTemplate.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), active: false } });
    await req.audit({ action: 'delete', module: 'pdfTemplates', recordId: req.params.id, details: 'PDF template deleted' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post('/:id/duplicate', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const source = await prisma.pdfTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!source) return res.status(404).json({ error: 'Template not found' });
    const { id, createdAt, updatedAt, usageCount, lastUsedAt, ...copy } = source;
    const template = await prisma.pdfTemplate.create({
      data: { ...copy, name: req.body.name || `${source.name} (copy)`, isDefault: false, createdById: req.user.id },
    });
    res.status(201).json(template);
  } catch (err) { next(err); }
});

// ── VALIDATION AND DISCOVERY ──────────────────────────────────────────

router.post('/validate', authenticate, async (req, res, next) => {
  try {
    const { bodyHtml } = req.body;
    if (!bodyHtml) return res.status(400).json({ error: 'bodyHtml required' });
    res.json(validateTemplate(bodyHtml));
  } catch (err) { next(err); }
});

// Which merge fields are available for a module
router.get('/fields/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.params;
    const model = MODEL_FOR[module];
    if (!model) return res.status(400).json({ error: `Unsupported module: ${module}` });

    const sample = await prisma[model].findFirst({ where: { deletedAt: null } });
    const singular = module.replace(/s$/, '');

    const describe = (obj, prefix) => Object.entries(obj || {})
      .filter(([k, v]) => typeof v !== 'object' || v instanceof Date || v === null)
      .map(([k, v]) => ({
        path: `${prefix}.${k}`,
        type: v instanceof Date ? 'date' : v === null ? 'unknown' : typeof v,
        sample: v instanceof Date ? v.toISOString().slice(0, 10) : v === null ? null : String(v).slice(0, 40),
      }));

    const groups = [{ group: singular, fields: sample ? describe(sample, singular) : [] }];

    const relatedSamples = { account: 'account', contact: 'contact', owner: 'user' };
    for (const [alias, rel] of Object.entries(relatedSamples)) {
      try {
        const r = await prisma[rel].findFirst();
        if (r) groups.push({ group: alias, fields: describe(r, alias) });
      } catch { /* model may not exist */ }
    }

    groups.push({
      group: 'system',
      fields: [
        { path: 'system.date', type: 'string', sample: new Date().toLocaleDateString() },
        { path: 'system.year', type: 'number', sample: String(new Date().getFullYear()) },
        { path: 'today', type: 'date', sample: new Date().toISOString().slice(0, 10) },
      ],
    });

    if (['quotes', 'invoices', 'orders', 'contracts'].includes(module)) {
      groups.push({
        group: 'totals',
        fields: ['subtotal', 'tax', 'discount', 'grandTotal', 'itemCount'].map(f => ({ path: `totals.${f}`, type: 'number', sample: null })),
      });
      groups.push({
        group: 'lineItems (use inside {{#each lineItems}})',
        fields: ['name', 'quantity', 'unitPrice', 'total', '@number'].map(f => ({ path: f, type: 'string', sample: null })),
      });
    }

    res.json({
      module,
      groups,
      formatters: Object.keys(FORMATTERS),
      syntax: {
        simple: '{{contact.firstName}}',
        formatted: '{{deal.amount|currency:USD}}',
        fallback: '{{contact.title|default:Unknown}}',
        loop: '{{#each lineItems}}{{name}}{{/each}}',
        conditional: '{{#if discount}}...{{else}}...{{/if}}',
      },
    });
  } catch (err) { next(err); }
});

router.get('/starters/:module', authenticate, async (req, res, next) => {
  const starter = STARTER_TEMPLATES[req.params.module];
  if (!starter) return res.status(404).json({ error: 'No starter template for that module' });
  res.json({ module: req.params.module, ...starter });
});

router.post('/starters/:module/install', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const starter = STARTER_TEMPLATES[req.params.module];
    if (!starter) return res.status(404).json({ error: 'No starter template for that module' });

    const existingDefault = await prisma.pdfTemplate.findFirst({ where: { module: req.params.module, isDefault: true, deletedAt: null } });
    const template = await prisma.pdfTemplate.create({
      data: {
        name: starter.name, module: req.params.module,
        bodyHtml: starter.bodyHtml, footerHtml: starter.footerHtml || null,
        isDefault: !existingDefault, createdById: req.user.id,
        description: 'Installed from starter template',
      },
    });
    res.status(201).json(template);
  } catch (err) { next(err); }
});

// ── RENDERING ─────────────────────────────────────────────────────────

// Preview with sample or real data, returned as HTML
router.post('/:id/preview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.pdfTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!template) return res.status(404).json({ error: 'Template not found' });

    let context;
    if (req.body.recordId) {
      const data = await loadRenderData(prisma, template.module, req.body.recordId);
      if (!data) return res.status(404).json({ error: 'Record not found' });
      context = buildContext(template.module, data.record, data.related);
    } else {
      // Fall back to the first available record, then to placeholders
      const model = MODEL_FOR[template.module];
      const sample = model ? await prisma[model].findFirst({ where: { deletedAt: null } }) : null;
      if (sample) {
        const data = await loadRenderData(prisma, template.module, sample.id);
        context = buildContext(template.module, data.record, data.related);
      } else {
        const singular = template.module.replace(/s$/, '');
        context = buildContext(template.module, { name: 'Sample Record', id: 'sample' }, {
          account: { name: 'Sample Account', billingCity: 'Toronto' },
          contact: { firstName: 'Sample', lastName: 'Contact', email: 'sample@example.com' },
          lineItems: [
            { name: 'Sample Item A', quantity: 2, unitPrice: 100, total: 200 },
            { name: 'Sample Item B', quantity: 1, unitPrice: 50, total: 50 },
          ],
        });
        context[singular] = { ...context[singular], name: 'Sample Record' };
      }
    }

    // Merge values are HTML-escaped by render(), so record data cannot inject
    // script here. The template's own markup is admin-authored and must stay
    // verbatim for the preview to mean anything, so it is not filtered; the
    // client renders it inside a sandboxed iframe, and this header covers the
    // case where the route is opened directly.
    const html = buildDocument(template, context);
    if (req.body.format === 'json') {
      return res.json({ html, mergeFields: extractMergeFields(template.bodyHtml) });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.send(html);
  } catch (err) { next(err); }
});

// Render against a specific record
router.post('/:id/render/:recordId', authenticate, auditMiddleware, async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.pdfTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    if (!template.active) return res.status(400).json({ error: 'Template is inactive' });

    const data = await loadRenderData(prisma, template.module, req.params.recordId);
    if (!data) return res.status(404).json({ error: 'Record not found' });

    const context = buildContext(template.module, data.record, data.related);
    const html = buildDocument(template, context);

    const fileName = `${template.module}-${req.params.recordId.slice(0, 8)}-${Date.now()}.html`;
    const durationMs = Date.now() - startedAt;

    await prisma.pdfRender.create({
      data: {
        templateId: template.id, module: template.module, recordId: req.params.recordId,
        fileName, sizeBytes: Buffer.byteLength(html, 'utf8'),
        renderedById: req.user.id, durationMs, status: 'Success',
      },
    });
    await prisma.pdfTemplate.update({ where: { id: template.id }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date() } });
    await req.audit({ action: 'create', module: 'pdfTemplates', recordId: template.id, details: `Rendered ${template.module}/${req.params.recordId}` });

    if (req.query.download === 'true') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.send(html);
    }
    if (req.query.format === 'json') {
      return res.json({ html, fileName, sizeBytes: Buffer.byteLength(html, 'utf8'), durationMs });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    try {
      await req.app.locals.prisma.pdfRender.create({
        data: { templateId: req.params.id, module: 'unknown', recordId: req.params.recordId, fileName: 'failed', renderedById: req.user?.id, durationMs: Date.now() - startedAt, status: 'Failed', error: String(err.message).slice(0, 500) },
      });
    } catch { /* logging must not mask the original error */ }
    next(err);
  }
});

// Render the module default without naming a template
router.post('/render/:module/:recordId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.pdfTemplate.findFirst({
      where: { module: req.params.module, deletedAt: null, active: true },
      orderBy: { isDefault: 'desc' },
    });
    if (!template) return res.status(404).json({ error: `No active template for module ${req.params.module}` });

    const data = await loadRenderData(prisma, req.params.module, req.params.recordId);
    if (!data) return res.status(404).json({ error: 'Record not found' });

    const html = buildDocument(template, buildContext(req.params.module, data.record, data.related));
    await prisma.pdfTemplate.update({ where: { id: template.id }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date() } });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { next(err); }
});

// Batch render across many records
router.post('/:id/batch', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { recordIds } = req.body;
    if (!recordIds?.length) return res.status(400).json({ error: 'recordIds required' });
    if (recordIds.length > 200) return res.status(400).json({ error: 'Batch limit is 200 records' });

    const template = await prisma.pdfTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const rendered = [], failed = [];
    for (const recordId of recordIds) {
      try {
        const data = await loadRenderData(prisma, template.module, recordId);
        if (!data) { failed.push({ recordId, reason: 'not found' }); continue; }
        const html = buildDocument(template, buildContext(template.module, data.record, data.related));
        rendered.push({ recordId, sizeBytes: Buffer.byteLength(html, 'utf8'), html: req.body.includeHtml ? html : undefined });
      } catch (e) { failed.push({ recordId, reason: String(e.message).slice(0, 120) }); }
    }

    await prisma.pdfTemplate.update({ where: { id: template.id }, data: { usageCount: { increment: rendered.length }, lastUsedAt: new Date() } });
    res.json({ requested: recordIds.length, rendered: rendered.length, failed: failed.length, results: rendered, failures: failed });
  } catch (err) { next(err); }
});

router.get('/:id/renders', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const renders = await prisma.pdfRender.findMany({
      where: { templateId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(req.query.limit, 10) || 50, 200),
    });
    res.json(renders);
  } catch (err) { next(err); }
});

router.get('/analytics/usage', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const templates = await prisma.pdfTemplate.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, module: true, usageCount: true, lastUsedAt: true, active: true },
      orderBy: { usageCount: 'desc' },
    });
    const renders = await prisma.pdfRender.findMany({ select: { status: true, durationMs: true, createdAt: true }, take: 1000, orderBy: { createdAt: 'desc' } });
    const failures = renders.filter(r => r.status !== 'Success').length;
    const avgMs = renders.length ? Math.round(renders.reduce((s, r) => s + r.durationMs, 0) / renders.length) : 0;

    res.json({
      totalTemplates: templates.length,
      activeTemplates: templates.filter(t => t.active).length,
      unusedTemplates: templates.filter(t => t.usageCount === 0).map(t => ({ id: t.id, name: t.name })),
      totalRenders: renders.length,
      failedRenders: failures,
      avgRenderMs: avgMs,
      byModule: templates.reduce((a, t) => { a[t.module] = (a[t.module] || 0) + t.usageCount; return a; }, {}),
      topTemplates: templates.slice(0, 10),
    });
  } catch (err) { next(err); }
});

module.exports = router;
