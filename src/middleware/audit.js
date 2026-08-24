/**
 * Audit Middleware (Enhanced)
 * 
 * Field-level change tracking: logs which fields changed, old and new values.
 * Supports both simple audit entries and detailed change sets.
 */

const { diffFields, formatChanges } = require('../utils/integrity');
const { logger } = require('../services/logger');

// Create an audit log entry
async function audit(prisma, { action, module, recordId, details, changes, userId }) {
  try {
    let detailStr = details || '';
    if (changes && changes.length > 0) {
      detailStr = detailStr ? `${detailStr} | ${formatChanges(changes)}` : formatChanges(changes);
    }
    await prisma.auditLog.create({
      data: {
        action,
        module,
        recordId: recordId || null,
        details: typeof detailStr === 'object' ? JSON.stringify(detailStr) : detailStr || null,
        userId,
      },
    });
  } catch (err) {
    logger.error({ err, action, module }, 'Audit log write failed');
  }
}

// Express middleware: adds audit helper and field-level tracking to req
function auditMiddleware(req, res, next) {
  req.audit = (opts) => audit(req.app.locals.prisma, { ...opts, userId: req.userId });

  // Helper: audit an update with automatic field diff
  req.auditUpdate = async (module, recordId, oldRecord, newData) => {
    const changes = diffFields(oldRecord, newData);
    if (changes.length === 0) return; // No actual changes
    await audit(req.app.locals.prisma, {
      action: 'update',
      module,
      recordId,
      details: `Updated ${module.slice(0, -1)}`,
      changes,
      userId: req.userId,
    });
  };

  next();
}

module.exports = { audit, auditMiddleware };
