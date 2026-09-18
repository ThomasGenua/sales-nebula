const { Prisma } = require('@prisma/client');

/**
 * Keep only the keys a model actually declares.
 *
 * Routes that spread req.body into a Prisma write turn any stray key into a
 * 500 — and worse, Prisma then reports the *wrong* field, because one unknown
 * key stops it matching the unchecked-create input type and it complains about
 * the relation scalars instead. A client sending `assigneeId` for `assignedId`
 * got "Unknown argument `dealId`".
 *
 * Relation keys are kept so nested writes such as { items: { create: [...] } }
 * still work. Ignored keys are returned rather than dropped in silence.
 */
function pickModelFields(modelName, data = {}) {
  const model = Prisma.dmmf.datamodel.models.find(
    m => m.name.toLowerCase() === String(modelName).toLowerCase()
  );
  if (!model) return { data, ignored: [] };

  const byName = new Map(model.fields.map(f => [f.name, f]));
  const kept = {};
  const ignored = [];
  for (const [key, value] of Object.entries(data)) {
    const field = byName.get(key);
    if (!field) { ignored.push(key); continue; }
    kept[key] = coerce(field, value);
  }
  return { data: kept, ignored };
}

/** Whether a model declares a given field. */
function modelHasField(modelName, field) {
  const model = Prisma.dmmf.datamodel.models.find(
    m => m.name.toLowerCase() === String(modelName).toLowerCase()
  );
  return !!model?.fields.some(f => f.name === field);
}

/**
 * Nudge a value into the shape Prisma expects.
 *
 * Date inputs submit "2026-06-30", which Prisma rejects because it is not a
 * full ISO-8601 DateTime — a plain date picker was enough to 500 a create.
 * An unparseable value is passed through so Prisma still reports it.
 */
function coerce(field, value) {
  if (field.type === 'DateTime' && typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }
  return value;
}

module.exports = { pickModelFields, modelHasField };
