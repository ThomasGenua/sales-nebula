const CHECKS = ['need', 'budget', 'authority', 'timeline', 'decisionProcess'];
const KEY = 'sales.stageRequirements';
function problem(message) { return Object.assign(new Error(message), { status: 400 }); }
function validateRequirements(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('Stage requirements must be an object');
  for (const [stage, fields] of Object.entries(value)) {
    if (!stage.trim() || !Array.isArray(fields) || fields.some(f => ![...CHECKS, 'nextStep', 'nextStepDate', 'contactId'].includes(f))) throw problem('Invalid stage requirement');
  }
  return value;
}
async function prepareDeal(db, data, old = {}) {
  if (data.qualification !== undefined) {
    if (data.qualification === null) data.qualification = {};
    const q = data.qualification;
    if (!q || typeof q !== 'object' || Array.isArray(q) || Object.keys(q).some(k => !CHECKS.includes(k)) || Object.values(q).some(v => typeof v !== 'boolean')) throw problem('Qualification must contain boolean checklist values');
  }
  if (data.nextStep !== undefined && data.nextStep !== null && (typeof data.nextStep !== 'string' || data.nextStep.length > 2000)) throw problem('Next step must be at most 2000 characters');
  if (data.nextStepDate && !Number.isFinite(+new Date(data.nextStepDate))) throw problem('Invalid next step date');
  const record = { ...old, ...data };
  const settings = await db.setting.findUnique({ where: { key: KEY } });
  const stages = settings ? JSON.parse(settings.value) : {};
  const stage = record.stage || 'Qualification';
  const required = Object.prototype.hasOwnProperty.call(stages, stage) ? stages[stage] : [];
  const missing = required.filter(f => CHECKS.includes(f) ? record.qualification?.[f] !== true : !record[f]);
  if (missing.length) throw problem(`Complete before saving ${record.stage}: ${missing.join(', ')}`);
  return data;
}
module.exports = { CHECKS, KEY, validateRequirements, prepareDeal };
