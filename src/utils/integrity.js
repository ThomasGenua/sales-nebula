/**
 * Data Integrity Utilities
 * 
 * - Field-level audit: tracks which fields changed and old/new values
 * - Optimistic locking: prevents silent overwrites with version checking
 * - Soft deletes: marks records as deleted instead of removing them
 * - Validation constraints: enforces business rules on field values
 */

// ─── FIELD-LEVEL AUDIT DIFF ───
// Compare old and new objects, return list of changed fields with before/after values
function diffFields(oldRecord, newData, ignoreFields = ['updatedAt', 'createdAt', 'password']) {
  const changes = [];
  for (const [key, newVal] of Object.entries(newData)) {
    if (ignoreFields.includes(key)) continue;
    if (key === 'id') continue;
    const oldVal = oldRecord[key];
    if (oldVal === undefined) continue; // Field doesn't exist on old record

    // Compare (handle dates, nulls, nested objects)
    const oldStr = oldVal instanceof Date ? oldVal.toISOString() : JSON.stringify(oldVal);
    const newStr = newVal instanceof Date ? newVal.toISOString() : JSON.stringify(newVal);

    if (oldStr !== newStr) {
      changes.push({
        field: key,
        oldValue: oldVal,
        newValue: newVal,
      });
    }
  }
  return changes;
}

// Format changes for audit log storage
function formatChanges(changes) {
  if (!changes.length) return 'No changes';
  return changes.map(c => {
    const old = c.oldValue === null ? 'null' : String(c.oldValue).substring(0, 100);
    const nw = c.newValue === null ? 'null' : String(c.newValue).substring(0, 100);
    return `${c.field}: "${old}" -> "${nw}"`;
  }).join('; ');
}

// ─── OPTIMISTIC LOCKING ───
// Middleware factory: checks version field before update
function optimisticLock(modelName) {
  return async (req, res, next) => {
    if (req.method !== 'PUT' && req.method !== 'PATCH') return next();

    const expectedVersion = req.body._version || req.headers['if-match'];
    if (!expectedVersion) return next(); // No version provided, skip check

    try {
      const prisma = req.app.locals.prisma;
      const current = await prisma[modelName].findUnique({
        where: { id: req.params.id },
        select: { updatedAt: true },
      });

      if (!current) return res.status(404).json({ error: 'Record not found' });

      const currentVersion = current.updatedAt.toISOString();
      if (currentVersion !== expectedVersion) {
        return res.status(409).json({
          error: 'Record has been modified by another user',
          code: 'CONFLICT',
          currentVersion,
          yourVersion: expectedVersion,
        });
      }

      // Remove internal version field from body
      delete req.body._version;
      next();
    } catch (err) { next(err); }
  };
}

// ─── SOFT DELETE HELPERS ───
// These work with models that have a `deletedAt` DateTime? field

function softDeleteWhere(where = {}) {
  return { ...where, deletedAt: null };
}

function applySoftDelete(prisma, modelName) {
  return {
    // Override findMany to exclude soft-deleted
    findMany: (args = {}) => {
      args.where = softDeleteWhere(args.where);
      return prisma[modelName].findMany(args);
    },
    // Soft delete: set deletedAt instead of removing
    softDelete: (id) => {
      return prisma[modelName].update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    },
    // Restore a soft-deleted record
    restore: (id) => {
      return prisma[modelName].update({
        where: { id },
        data: { deletedAt: null },
      });
    },
    // Hard delete (actually remove)
    hardDelete: (id) => {
      return prisma[modelName].delete({ where: { id } });
    },
    // Find including deleted
    findWithDeleted: (args = {}) => {
      return prisma[modelName].findMany(args);
    },
    // Count excluding deleted
    count: (where = {}) => {
      return prisma[modelName].count({ where: softDeleteWhere(where) });
    },
  };
}

// ─── VALIDATION CONSTRAINTS ───
// Business rules for field values

const VALID_STAGES = ['Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
const VALID_LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'];
const VALID_CASE_STATUSES = ['New', 'Open', 'Escalated', 'Resolved', 'Closed'];
const VALID_CASE_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const VALID_INVOICE_STATUSES = ['Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled'];
const VALID_QUOTE_STATUSES = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired'];
const VALID_CAMPAIGN_STATUSES = ['Planned', 'Planning', 'Active', 'Sent', 'Paused', 'Completed', 'Aborted'];

const constraints = {
  deal: {
    stage: (v) => VALID_STAGES.includes(v) ? null : `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}`,
    probability: (v) => {
      const n = Number(v);
      return (Number.isInteger(n) && n >= 0 && n <= 100) ? null : 'Probability must be 0-100';
    },
    value: (v) => (typeof v === 'number' && v >= 0) ? null : 'Value must be a non-negative number',
  },
  lead: {
    status: (v) => VALID_LEAD_STATUSES.includes(v) ? null : `Invalid status. Must be one of: ${VALID_LEAD_STATUSES.join(', ')}`,
    score: (v) => {
      if (v === undefined || v === null) return null;
      const n = Number(v);
      return (Number.isInteger(n) && n >= 0 && n <= 100) ? null : 'Score must be 0-100';
    },
  },
  case: {
    status: (v) => VALID_CASE_STATUSES.includes(v) ? null : `Invalid case status`,
    priority: (v) => VALID_CASE_PRIORITIES.includes(v) ? null : `Invalid priority`,
  },
  invoice: {
    status: (v) => VALID_INVOICE_STATUSES.includes(v) ? null : `Invalid invoice status`,
    total: (v) => (typeof v === 'number' && v >= 0) ? null : 'Total must be non-negative',
  },
  quote: {
    status: (v) => VALID_QUOTE_STATUSES.includes(v) ? null : `Invalid quote status`,
  },
  campaign: {
    status: (v) => VALID_CAMPAIGN_STATUSES.includes(v) ? null : `Invalid campaign status`,
  },
};

// Validate data against constraints for a module
function validateConstraints(module, data) {
  const moduleConstraints = constraints[module];
  if (!moduleConstraints) return { valid: true, errors: {} };

  const errors = {};
  for (const [field, validator] of Object.entries(moduleConstraints)) {
    if (data[field] !== undefined) {
      const error = validator(data[field]);
      if (error) errors[field] = error;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Middleware factory for constraint validation
function validateBody(module) {
  return (req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return next();
    const { valid, errors } = validateConstraints(module, req.body);
    if (!valid) return res.status(400).json({ error: 'Validation failed', errors });
    next();
  };
}

module.exports = {
  diffFields,
  formatChanges,
  optimisticLock,
  softDeleteWhere,
  applySoftDelete,
  validateConstraints,
  validateBody,
  constraints,
  VALID_STAGES,
  VALID_LEAD_STATUSES,
  VALID_CASE_STATUSES,
  VALID_CASE_PRIORITIES,
  VALID_INVOICE_STATUSES,
  VALID_QUOTE_STATUSES,
  VALID_CAMPAIGN_STATUSES,
};
