const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { createRecord, updateRecord, runAfter } = require('../services/recordWrites');
const custom = require('../services/customFields');
const { linkRefusal } = require('../middleware/access');

// Only administrators import records on someone else's behalf; everyone
// else's imports are theirs.
const OWNERSHIP_FIELDS = ['ownerId', 'assignedId'];

const router = Router();
router.use(authenticate, auditMiddleware);

// Columns the models have. zip, linkedin, twitter and a lead's website are
// not, and any row carrying one failed to import ("Unknown argument").
const IMPORTABLE_MODULES = {
  contacts: {
    model: 'contact',
    required: ['firstName', 'lastName'],
    fields: ['firstName', 'lastName', 'email', 'phone', 'title', 'department', 'accountId', 'ownerId', 'source', 'address', 'city', 'state', 'country', 'description'],
    dedupeFields: ['email'],
  },
  leads: {
    model: 'lead',
    // company is a required column: a row without it failed at the database.
    required: ['firstName', 'lastName', 'company'],
    fields: ['firstName', 'lastName', 'email', 'phone', 'company', 'title', 'source', 'status', 'address', 'city', 'state', 'country', 'description', 'ownerId', 'assignedId'],
    dedupeFields: ['email'],
  },
  accounts: {
    model: 'account',
    required: ['name'],
    fields: ['name', 'industry', 'website', 'phone', 'address', 'city', 'state', 'country', 'employees', 'revenue', 'type', 'description', 'ownerId'],
    dedupeFields: ['name'],
  },
  products: {
    model: 'product',
    required: ['name', 'sku'],
    fields: ['name', 'sku', 'description', 'price', 'cost', 'category', 'active'],
    dedupeFields: ['sku'],
  },
};

// GET import metadata (available modules + field mappings)
router.get('/metadata', async (req, res, next) => {
  try {
  const metadata = {};
  for (const [mod, config] of Object.entries(IMPORTABLE_MODULES)) {
    if (!permits(req, mod, 'edit')) continue;
    const extra = (await custom.definitions(req.app.locals.prisma, mod)).filter(f => f.supported && !f.readOnly);
    metadata[mod] = {
      requiredFields: [...config.required, ...extra.filter(f => f.required && f.defaultValue == null).map(f => 'custom.' + f.name)],
      availableFields: [...config.fields.filter(f => isAdmin(req.user) || !OWNERSHIP_FIELDS.includes(f)), ...extra.map(f => 'custom.' + f.name)],
      labels: Object.fromEntries(extra.map(f => ['custom.' + f.name, f.label])),
      dedupeFields: config.dedupeFields,
    };
  }
  res.json({ modules: Object.keys(metadata), metadata });
  } catch (e) { next(e); }
});

// POST /import/validate - Validate data before import (dry run)
router.post('/validate', async (req, res, next) => {
  try {
    const { module, records, fieldMapping } = req.body;
    if (!module || !IMPORTABLE_MODULES[module]) {
      return res.status(400).json({ error: `Invalid module. Supported: ${Object.keys(IMPORTABLE_MODULES).join(', ')}` });
    }
    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array is required and must not be empty' });
    }
    if (records.length > 10000) {
      return res.status(400).json({ error: 'Maximum 10,000 records per import' });
    }

    const config = IMPORTABLE_MODULES[module];
    if (!permits(req, module, 'edit')) return res.status(403).json({ error: 'Insufficient permissions' });
    const prisma = req.app.locals.prisma;
    const extra = (await custom.definitions(prisma, module)).filter(f => f.supported && !f.readOnly);
    const mapping = fieldMapping || {};
    const errors = [];
    const warnings = [];
    const duplicates = [], preview = [], seen = new Map();

    for (const [index, record] of records.entries()) {
      const mapped = applyMapping(record, mapping);

      // Check required fields
      for (const field of config.required) {
        if (!mapped[field] || String(mapped[field]).trim() === '') {
          errors.push({ row: index + 1, field, message: `${field} is required` });
        }
      }

      // Check unknown fields
      for (const key of Object.keys(mapped)) {
        if (!config.fields.includes(key) && !extra.some(f => 'custom.' + f.name === key)) {
          warnings.push({ row: index + 1, field: key, message: `Unknown field will be ignored` });
        }
      }

      // Validate email format
      if (mapped.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mapped.email)) {
        errors.push({ row: index + 1, field: 'email', message: 'Invalid email format' });
      }
      try {
        const dedupeField = config.dedupeFields[0], key = String(mapped[dedupeField] || '').trim().toLowerCase();
        const existing = key && await prisma[config.model].findFirst({ where: await reachableWhere(req, module, config.model, { [dedupeField]: { equals: key, mode: 'insensitive' } }, req.body.updateDuplicates ? 'Edit' : 'Read'), select: { id: true } });
        if (existing || key && seen.has(key)) duplicates.push({ row: index + 1, field: dedupeField, value: mapped[dedupeField], kind: existing ? 'existing' : 'file', ...(seen.has(key) && { firstRow: seen.get(key) }) });
        if (key && !seen.has(key)) seen.set(key, index + 1);
        const data = Object.fromEntries(config.fields.filter(f => (isAdmin(req.user) || !OWNERSHIP_FIELDS.includes(f)) && mapped[f] !== undefined && mapped[f] !== '').map(f => [f, coerceField(f, mapped[f])]));
        const links = await linkRefusal(req, config.model, data); if (links) throw new Error(links);
        await custom.prepareValues(prisma, module, customInput(mapped), req.body.updateDuplicates ? existing?.id : null, { useDefaults: true });
        if (preview.length < 20) preview.push({ row: index + 1, values: { ...data, ...Object.fromEntries(Object.entries(mapped).filter(([k]) => k.startsWith('custom.'))) } });
      } catch (e) { errors.push({ row: index + 1, field: 'record', message: e.message }); }
    }

    res.json({
      valid: errors.length === 0,
      totalRecords: records.length,
      errors,
      warnings: warnings.slice(0, 50),
      errorCount: errors.length,
      warningCount: warnings.length,
      duplicates: duplicates.slice(0, 1000), duplicateCount: duplicates.length, preview,
    });
  } catch (err) { next(err); }
});

// POST /import/execute - Execute the import
router.post('/execute', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, records, fieldMapping, skipDuplicates = true, updateDuplicates = false } = req.body;

    if (!module || !IMPORTABLE_MODULES[module]) {
      return res.status(400).json({ error: `Invalid module` });
    }
    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array required' });
    }
    if (records.length > 10000) {
      return res.status(400).json({ error: 'Maximum 10,000 records per import' });
    }

    // An import took a session alone, set owners, and with updateDuplicates
    // overwrote whichever records matched, anyone's. It now takes edit
    // permission on the module and touches only records the caller can see
    // (to skip) or change (to update).
    if (!permits(req, module, 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });

    const config = IMPORTABLE_MODULES[module];
    const fields = isAdmin(req.user) ? config.fields : config.fields.filter(f => !OWNERSHIP_FIELDS.includes(f));
    const mapping = fieldMapping || {};
    const results = { created: 0, updated: 0, skipped: 0, errors: [] };

    // Build dedupe lookup
    const dedupeMap = new Map();
    if (config.dedupeFields.length > 0 && (skipDuplicates || updateDuplicates)) {
      const dedupeField = config.dedupeFields[0];
      // Trimmed, as they are stored, and looked up whatever their case: the map
      // below compares in lower case, but the lookup was an exact `in`, so a
      // file with ADA@EXAMPLE.COM did not find the ada@example.com already
      // there and created a second contact. Chunked, because each value is one
      // condition and a file may carry thousands.
      const values = [...new Set(records
        .map(r => applyMapping(r, mapping)[dedupeField])
        .filter(Boolean)
        .map(v => String(v).trim())
        .filter(Boolean))];

      for (let i = 0; i < values.length; i += 200) {
        const chunk = values.slice(i, i + 200);
        const existing = await prisma[config.model].findMany({
          where: await reachableWhere(
            req, module, config.model,
            { OR: chunk.map(value => ({ [dedupeField]: { equals: value, mode: 'insensitive' } })) },
            updateDuplicates ? 'Edit' : 'Read',
          ),
          select: { id: true, [dedupeField]: true },
        });
        for (const rec of existing) {
          dedupeMap.set(String(rec[dedupeField]).trim().toLowerCase(), rec.id);
        }
      }
    }

    // Each row is written as a record made on its own page would be: the
    // module's validation, duplicate and assignment rules, then its workflows
    // and webhooks (services/recordWrites). An import skipped them all. A row
    // may link only to records the importer can see (a contact's account);
    // each linked record is looked up once for the whole file.
    const write = { req, userId: req.userId, source: 'import', linkCache: new Map() };

    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);

      for (let j = 0; j < batch.length; j++) {
        const rowNum = i + j + 1;
        try {
          const mapped = applyMapping(batch[j], mapping);
          if (mapped.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(mapped.email).trim())) throw new Error('Invalid email format');

          // Filter to valid fields only
          const data = {};
          for (const field of fields) {
            if (mapped[field] !== undefined && mapped[field] !== null && mapped[field] !== '') {
              data[field] = coerceField(field, mapped[field]);
            }
          }

          // Check required
          const missingRequired = config.required.filter(f => !data[f]);
          if (missingRequired.length > 0) {
            results.errors.push({ row: rowNum, error: `Missing required: ${missingRequired.join(', ')}` });
            results.skipped++;
            continue;
          }

          // Check duplicates
          const dedupeField = config.dedupeFields[0];
          const dedupeValue = data[dedupeField] ? String(data[dedupeField]).toLowerCase() : null;
          const existingId = dedupeValue ? dedupeMap.get(dedupeValue) : null;

          if (existingId) {
            if (updateDuplicates) {
              const after = [];
              await prisma.$transaction(async tx => {
                const values = await custom.prepareValues(tx, module, customInput(mapped), existingId, { useDefaults: true });
                await updateRecord(tx, module, existingId, data, { ...write, after, prisma });
                await custom.saveValues(tx, values, existingId);
              });
              await runAfter(after);
              results.updated++;
            } else {
              results.skipped++;
            }
            continue;
          }

          // With no owner in the row, the module's assignment rules pick one,
          // and failing them the importer owns it.
          const after = [];
          const created = await prisma.$transaction(async tx => {
            const values = await custom.prepareValues(tx, module, customInput(mapped), null, { useDefaults: true });
            const { record } = await createRecord(tx, module, data, { ...write, after, prisma });
            await custom.saveValues(tx, values, record.id);
            return record;
          });
          await runAfter(after);

          // Add to dedupe map for intra-batch dedup
          if (dedupeValue) dedupeMap.set(dedupeValue, created.id);
          results.created++;

        } catch (err) {
          results.errors.push({ row: rowNum, error: err.code === 'P2002' ? 'A unique field value is already in use.' : err.message.slice(0, 200) });
          results.skipped++;
        }
      }
    }

    await req.audit({
      action: 'create',
      module,
      details: `Bulk import: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`,
    });

    // Fire webhook
    try {
      const { fireWebhookEvent } = require('../services/webhooks');
      await fireWebhookEvent(prisma, `${module}.imported`, { ...results, importedBy: req.userId });
    } catch (e) { /* best-effort */ }

    res.json({
      success: true,
      ...results,
      errors: results.errors,
    });
  } catch (err) { next(err); }
});

function applyMapping(record, mapping) {
  if (Object.keys(mapping).length === 0) return record;
  const mapped = {};
  for (const [csvCol, crmField] of Object.entries(mapping)) {
    if (crmField && record[csvCol] !== undefined) {
      mapped[crmField] = record[csvCol];
    }
  }
  // Also include any unmapped fields that already match CRM field names
  for (const [key, value] of Object.entries(record)) {
    if (!Object.hasOwn(mapping, key) && !Object.values(mapping).includes(key)) {
      mapped[key] = value;
    }
  }
  return mapped;
}

function coerceField(field, value) {
  if (['price', 'cost', 'revenue', 'employees'].includes(field)) {
    const num = Number(value);
    if (!Number.isFinite(num) || field === 'employees' && !Number.isInteger(num)) throw new Error(field + ' must be a valid number');
    return num;
  }
  if (field === 'active') {
    if (![true, false, 'true', 'false', '1', '0', 'yes', 'no'].includes(value)) throw new Error('active must be yes or no');
    return value === true || value === 'true' || value === '1' || value === 'yes';
  }
  return String(value).trim();
}
function customInput(mapped) { return Object.fromEntries(Object.entries(mapped).filter(([key]) => key.startsWith('custom.')).map(([key, value]) => [key.slice(7), value])); }

module.exports = router;
