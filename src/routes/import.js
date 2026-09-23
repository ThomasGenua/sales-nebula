const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');

// Only administrators import records on someone else's behalf; everyone
// else's imports are theirs.
const OWNERSHIP_FIELDS = ['ownerId', 'assignedId'];

const router = Router();
router.use(authenticate, auditMiddleware);

const IMPORTABLE_MODULES = {
  contacts: {
    model: 'contact',
    required: ['firstName', 'lastName'],
    fields: ['firstName', 'lastName', 'email', 'phone', 'title', 'department', 'accountId', 'ownerId', 'source', 'address', 'city', 'state', 'country', 'zip', 'linkedin', 'twitter', 'description'],
    dedupeFields: ['email'],
  },
  leads: {
    model: 'lead',
    required: ['firstName', 'lastName'],
    fields: ['firstName', 'lastName', 'email', 'phone', 'company', 'title', 'source', 'status', 'address', 'city', 'state', 'country', 'zip', 'website', 'description', 'ownerId', 'assignedId'],
    dedupeFields: ['email'],
  },
  accounts: {
    model: 'account',
    required: ['name'],
    fields: ['name', 'industry', 'website', 'phone', 'address', 'city', 'state', 'country', 'zip', 'employees', 'revenue', 'type', 'description', 'ownerId'],
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
router.get('/metadata', async (req, res) => {
  const metadata = {};
  for (const [mod, config] of Object.entries(IMPORTABLE_MODULES)) {
    metadata[mod] = {
      requiredFields: config.required,
      availableFields: config.fields,
      dedupeFields: config.dedupeFields,
    };
  }
  res.json({ modules: Object.keys(IMPORTABLE_MODULES), metadata });
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
    const mapping = fieldMapping || {};
    const errors = [];
    const warnings = [];

    records.forEach((record, index) => {
      const mapped = applyMapping(record, mapping);

      // Check required fields
      for (const field of config.required) {
        if (!mapped[field] || String(mapped[field]).trim() === '') {
          errors.push({ row: index + 1, field, message: `${field} is required` });
        }
      }

      // Check unknown fields
      for (const key of Object.keys(mapped)) {
        if (!config.fields.includes(key)) {
          warnings.push({ row: index + 1, field: key, message: `Unknown field will be ignored` });
        }
      }

      // Validate email format
      if (mapped.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mapped.email)) {
        errors.push({ row: index + 1, field: 'email', message: 'Invalid email format' });
      }
    });

    res.json({
      valid: errors.length === 0,
      totalRecords: records.length,
      errors: errors.slice(0, 100), // Cap at 100 errors
      warnings: warnings.slice(0, 50),
      errorCount: errors.length,
      warningCount: warnings.length,
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
      const values = records
        .map(r => applyMapping(r, mapping)[dedupeField])
        .filter(Boolean)
        .map(String);

      if (values.length > 0) {
        const existing = await prisma[config.model].findMany({
          where: await reachableWhere(req, module, config.model, { [dedupeField]: { in: values } }, updateDuplicates ? 'Edit' : 'Read'),
          select: { id: true, [dedupeField]: true },
        });
        for (const rec of existing) {
          dedupeMap.set(String(rec[dedupeField]).toLowerCase(), rec.id);
        }
      }
    }

    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);

      for (let j = 0; j < batch.length; j++) {
        const rowNum = i + j + 1;
        try {
          const mapped = applyMapping(batch[j], mapping);

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
              await prisma[config.model].update({ where: { id: existingId }, data });
              results.updated++;
            } else {
              results.skipped++;
            }
            continue;
          }

          // Set owner if not specified
          if (config.fields.includes('ownerId') && !data.ownerId) {
            data.ownerId = req.userId;
          }

          const created = await prisma[config.model].create({ data });

          // Add to dedupe map for intra-batch dedup
          if (dedupeValue) dedupeMap.set(dedupeValue, created.id);
          results.created++;

        } catch (err) {
          results.errors.push({ row: rowNum, error: err.message.slice(0, 200) });
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
      errors: results.errors.slice(0, 100),
    });
  } catch (err) { next(err); }
});

function applyMapping(record, mapping) {
  if (Object.keys(mapping).length === 0) return record;
  const mapped = {};
  for (const [csvCol, crmField] of Object.entries(mapping)) {
    if (record[csvCol] !== undefined) {
      mapped[crmField] = record[csvCol];
    }
  }
  // Also include any unmapped fields that already match CRM field names
  for (const [key, value] of Object.entries(record)) {
    if (!mapping[key] && !Object.values(mapping).includes(key)) {
      mapped[key] = value;
    }
  }
  return mapped;
}

function coerceField(field, value) {
  if (['price', 'cost', 'revenue', 'employees'].includes(field)) {
    const num = Number(value);
    return isNaN(num) ? null : num;
  }
  if (field === 'active') {
    return value === true || value === 'true' || value === '1' || value === 'yes';
  }
  return String(value).trim();
}

module.exports = router;
