const { Prisma } = require('@prisma/client');

/**
 * A lead's score from the lead scoring rules: 50, plus the points of each
 * active rule the lead matches, kept between 0 and 100.
 *
 * The web-to-lead form, POST /api/leads/:id/score and the admin rescore each
 * had a copy of this, and each knew different operators: a rule on
 * "endsWith" counted on request and not from the form, "notEquals" only on
 * request, and the seeded "is_not_empty" rules nowhere. So one lead could
 * score three ways. This is the one evaluator, and a save of a lead runs it.
 */

const BASE_SCORE = 50;

const blank = value => value === null || value === undefined || String(value).trim() === '';
const text = value => (blank(value) ? '' : String(value).toLowerCase());
const number = value => (blank(value) ? NaN : Number(value));

// Text compares regardless of case, as it always has here.
const OPERATORS = {
  equals: (value, target) => text(value) === text(target),
  notEquals: (value, target) => text(value) !== text(target),
  contains: (value, target) => text(value).includes(text(target)),
  startsWith: (value, target) => text(value).startsWith(text(target)),
  endsWith: (value, target) => text(value).endsWith(text(target)),
  greaterThan: (value, target) => number(value) > number(target),
  lessThan: (value, target) => number(value) < number(target),
  isEmpty: value => blank(value),
  isNotEmpty: value => !blank(value),
};
// As the seed spells them.
OPERATORS.is_empty = OPERATORS.isEmpty;
OPERATORS.is_not_empty = OPERATORS.isNotEmpty;

// A lead's own columns, but its score: that is what the rules set, and a rule
// reading it gave a lead a different score each time it was scored.
const FIELDS = new Set(Prisma.dmmf.datamodel.models.find(m => m.name === 'Lead').fields
  .filter(f => f.kind !== 'object' && f.name !== 'score').map(f => f.name));

// What the rules screen offers: the operators by their own names, and a
// lead's columns but its ids and timestamps. The seed's spellings and those
// columns are still scored.
const OFFERED = {
  operators: Object.keys(OPERATORS).filter(operator => !operator.includes('_')),
  fields: [...FIELDS].filter(field => field !== 'id' && !/Id$/.test(field) && !/At$/.test(field)).sort(),
};

const known = operator => typeof operator === 'string' && Object.hasOwn(OPERATORS, operator);
const matches = (rule, lead) => FIELDS.has(rule.field) && known(rule.operator) && OPERATORS[rule.operator](lead[rule.field], rule.value);

function scoreLead(rules, lead) {
  const score = rules.reduce((sum, rule) => (matches(rule, lead) ? sum + (Number(rule.points) || 0) : sum), BASE_SCORE);
  return Math.max(0, Math.min(100, Math.round(score)));
}

const activeScoringRules = prisma => prisma.leadScoringRule.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });

/**
 * `data`, for a save of a lead, with the score its rules give the lead as it
 * will be. With no active rule there is nothing to score by, and the score
 * is left as the caller sent it, or as it was.
 */
async function withRuleScore(prisma, data, oldRecord = null) {
  const rules = await activeScoringRules(prisma);
  if (!rules.length) return data;
  return { ...data, score: scoreLead(rules, { ...oldRecord, ...data }) };
}

/** Why a rule with these fields could never match a lead, or null. */
function scoringRuleProblem({ field, operator } = {}) {
  if (operator !== undefined && !known(operator)) {
    return `operator must be one of: ${Object.keys(OPERATORS).join(', ')}`;
  }
  if (field === 'score') return 'a rule cannot read the score it sets';
  if (field !== undefined && !FIELDS.has(field)) return `field must be one of a lead's fields; ${JSON.stringify(field)} is not`;
  return null;
}

module.exports = { BASE_SCORE, OFFERED, scoreLead, activeScoringRules, withRuleScore, scoringRuleProblem };
