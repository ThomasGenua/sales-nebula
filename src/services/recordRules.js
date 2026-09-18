const { modelHasField } = require('../utils/modelFields');
const { resolveModel } = require('./workflowEngine');

/**
 * The three record-level rule types that existed only as configuration.
 *
 * ValidationRule, AssignmentRule and DuplicateRule each had admin screens and
 * a table, and no code path anywhere read them on a write — so a validation
 * rule validated nothing, an assignment rule assigned nobody, and a duplicate
 * rule never saw a duplicate. They run from the shared CRUD router now.
 */

// ── conditions ────────────────────────────────────────────────────────

function compare(operator, left, right) {
  const value = left === null || left === undefined ? '' : left;
  switch (operator) {
    case 'equals': case 'eq': return String(value) === String(right);
    case 'notEquals': case 'ne': return String(value) !== String(right);
    case 'contains': return String(value).toLowerCase().includes(String(right).toLowerCase());
    case 'startsWith': return String(value).toLowerCase().startsWith(String(right).toLowerCase());
    case 'greaterThan': case 'gt': return Number(value) > Number(right);
    case 'lessThan': case 'lt': return Number(value) < Number(right);
    case 'gte': return Number(value) >= Number(right);
    case 'lte': return Number(value) <= Number(right);
    case 'isEmpty': return value === '' || value === null || value === undefined;
    case 'isNotEmpty': return !(value === '' || value === null || value === undefined);
    case 'in': return Array.isArray(right) && right.map(String).includes(String(value));
    case 'matches': try { return new RegExp(right, 'i').test(String(value)); } catch { return false; }
    default: return false;
  }
}

/** A single clause, or an { and: [...] } / { or: [...] } tree. */
function evaluate(condition, record) {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition.and)) return condition.and.every(c => evaluate(c, record));
  if (Array.isArray(condition.or)) return condition.or.some(c => evaluate(c, record));
  if (Array.isArray(condition)) return condition.every(c => evaluate(c, record));
  if (!condition.field) return false;
  return compare(condition.operator, record[condition.field], condition.value);
}

// ── validation ────────────────────────────────────────────────────────

/**
 * Validation rules describe the state that is *not* allowed, the way a
 * Salesforce validation formula does: the condition matching means reject.
 *
 * Returns the failures rather than throwing, so the caller decides the shape
 * of the response. An empty array means the record is acceptable.
 */
async function checkValidationRules(prisma, moduleName, record) {
  const rules = await prisma.validationRule.findMany({ where: { module: moduleName, active: true } })
    .catch(() => []);

  return rules
    .filter(rule => evaluate(rule.condition, record))
    .map(rule => ({
      rule: rule.name,
      field: rule.errorField || null,
      message: rule.errorMessage || `${rule.name} failed`,
    }));
}

// ── assignment ────────────────────────────────────────────────────────

/** Ownership columns this model actually has, so we only set real ones. */
function ownershipFields(modelName) {
  return ['assignedId', 'ownerId'].filter(f => modelHasField(modelName, f));
}

/**
 * Pick an owner for a new record.
 *
 * Round-robin advances the stored pointer with an atomic increment, so two
 * records created at the same moment do not land on the same person.
 * Returns the fields to merge into the create, or null when no rule applies.
 */
async function applyAssignmentRules(prisma, moduleName, data) {
  const modelName = resolveModel(moduleName);
  if (!modelName) return null;

  const fields = ownershipFields(modelName);
  if (!fields.length) return null;

  // Someone was named explicitly; a rule must not overrule that.
  if (fields.some(f => data[f])) return null;

  const rules = await prisma.assignmentRule.findMany({
    where: { module: moduleName, active: true },
    orderBy: { createdAt: 'asc' },
  }).catch(() => []);

  for (const rule of rules) {
    const assignees = Array.isArray(rule.assignees) ? rule.assignees.filter(Boolean) : [];
    if (!assignees.length) continue;

    if (rule.type === 'rule_based') {
      const conditions = rule.conditions;
      const matches = Array.isArray(conditions) ? conditions.every(c => evaluate(c, data)) : evaluate(conditions, data);
      if (!matches) continue;
      const assignee = assignees[0];
      return { assignee, rule: rule.name, fields: Object.fromEntries(fields.map(f => [f, assignee])) };
    }

    // round_robin
    const advanced = await prisma.assignmentRule.update({
      where: { id: rule.id },
      data: { lastIndex: { increment: 1 } },
      select: { lastIndex: true },
    });
    const assignee = assignees[(advanced.lastIndex - 1) % assignees.length];
    return { assignee, rule: rule.name, fields: Object.fromEntries(fields.map(f => [f, assignee])) };
  }

  return null;
}

// ── duplicates ────────────────────────────────────────────────────────

/**
 * Score existing records against the incoming one.
 *
 * Each configured field carries a weight; the score is the share of the
 * available weight that matched, so a rule with one field at weight 100 and a
 * matching email scores 100.
 */
async function findDuplicates(prisma, moduleName, data, { excludeId } = {}) {
  const modelName = resolveModel(moduleName);
  if (!modelName) return [];

  const rules = await prisma.duplicateRule.findMany({ where: { module: moduleName, active: true } })
    .catch(() => []);

  const findings = [];

  for (const rule of rules) {
    const matchFields = (Array.isArray(rule.matchFields) ? rule.matchFields : [])
      .filter(f => f?.field && modelHasField(modelName, f.field));
    if (!matchFields.length) continue;

    // Only look at records that share at least one field, rather than scanning.
    const or = matchFields
      .filter(f => data[f.field])
      .map(f => ({ [f.field]: data[f.field] }));
    if (!or.length) continue;

    const where = { OR: or };
    if (excludeId) where.id = { not: excludeId };
    if (modelHasField(modelName, 'deletedAt')) where.deletedAt = null;

    const candidates = await prisma[modelName].findMany({ where, take: 25 }).catch(() => []);
    const totalWeight = matchFields.reduce((sum, f) => sum + (Number(f.weight) || 0), 0) || 1;

    for (const candidate of candidates) {
      const matched = matchFields.filter(f => {
        const a = data[f.field];
        const b = candidate[f.field];
        return a && b && String(a).toLowerCase() === String(b).toLowerCase();
      });
      const score = Math.round((matched.reduce((sum, f) => sum + (Number(f.weight) || 0), 0) / totalWeight) * 100);
      if (score < (rule.threshold ?? 80)) continue;

      findings.push({
        ruleId: rule.id,
        rule: rule.name,
        // auto_merge is deliberately treated as warn: merging records without
        // a person looking is not something to do behind someone's back.
        action: rule.action === 'block' ? 'block' : 'warn',
        requestedAction: rule.action,
        score,
        matchedFields: matched.map(f => f.field),
        recordId: candidate.id,
      });
    }
  }

  return findings.sort((a, b) => b.score - a.score);
}

/** Keep a trace of a duplicate we allowed through, for the review queue. */
async function recordDuplicates(prisma, moduleName, newId, findings) {
  for (const finding of findings) {
    await prisma.duplicateRecord.create({
      data: {
        ruleId: finding.ruleId,
        module: moduleName,
        recordIdA: newId,
        recordIdB: finding.recordId,
        confidence: finding.score,
        status: 'Active',
      },
    }).catch(() => {});
  }
}

module.exports = {
  evaluate,
  checkValidationRules,
  applyAssignmentRules,
  findDuplicates,
  recordDuplicates,
};
