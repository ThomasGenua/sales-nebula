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

  const allowed = new Set(model.fields.map(f => f.name));
  const kept = {};
  const ignored = [];
  for (const [key, value] of Object.entries(data)) {
    if (allowed.has(key)) kept[key] = value;
    else ignored.push(key);
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

module.exports = { pickModelFields, modelHasField };
