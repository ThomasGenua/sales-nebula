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

const findModel = name => Prisma.dmmf.datamodel.models.find(
  m => m.name.toLowerCase() === String(name).toLowerCase()
);

/**
 * Split an `include` into what Prisma can resolve and what it cannot.
 *
 * Several routers ask to include `account`, `contact` or `deal` on models that
 * carry only the scalar `accountId` — Contract, Entitlement, WorkOrder, Asset,
 * Partner — and Prisma refuses the whole query, so those modules' list and
 * detail views never loaded. A key that names a real relation stays with
 * Prisma; a key with a matching `<key>Id` column and a model of that name is
 * resolved by `hydrateIncludes` instead; anything else is dropped.
 */
function resolveInclude(modelName, include) {
  const model = findModel(modelName);
  if (!model || !include || typeof include !== 'object') return { prismaInclude: include, manual: [] };

  const prismaInclude = {};
  const manual = [];
  for (const [key, spec] of Object.entries(include)) {
    if (!spec) continue;
    const field = model.fields.find(f => f.name === key);
    if (field && field.kind === 'object') { prismaInclude[key] = spec; continue; }

    const override = RELATION_OVERRIDES[`${model.name}.${key}`];
    const fkName = override?.fk || `${key}Id`;
    const fk = model.fields.find(f => f.name === fkName && f.kind === 'scalar');
    const related = findModel(override?.model || (USER_RELATIONS.has(key) ? 'User' : key));
    const select = spec && typeof spec === 'object' && spec.select ? spec.select : undefined;

    if (override?.many && related) {
      // One-to-many that the schema never declared: children carry our id.
      manual.push({ key, many: true, childFk: override.childFk, delegate: delegateOf(related), select, orderBy: override.orderBy });
    } else if (fk && related) {
      manual.push({ key, fkField: fk.name, delegate: delegateOf(related), select: select || (related.name === 'User' ? SAFE_USER : undefined) });
    }
  }
  return { prismaInclude: Object.keys(prismaInclude).length ? prismaInclude : undefined, manual };
}

const delegateOf = model => model.name.charAt(0).toLowerCase() + model.name.slice(1);

// Relation names that point at a user whatever the column is called.
const USER_RELATIONS = new Set(['user', 'owner', 'assignedTo', 'changedBy', 'installedBy', 'createdBy', 'author', 'requester', 'approver', 'submittedBy']);

// A user loaded this way must never carry the password hash.
const SAFE_USER = { id: true, firstName: true, lastName: true, email: true, avatar: true };

// Relations whose key does not follow `<name>Id` -> model `<Name>`.
const RELATION_OVERRIDES = {
  'FeedItem.user': { fk: 'authorId', model: 'User' },
  'FeedComment.user': { fk: 'authorId', model: 'User' },
  'InstalledApp.installedBy': { fk: 'userId', model: 'User' },
  'InstalledApp.listing': { fk: 'appId', model: 'AppListing' },
  'MarketplaceReview.user': { fk: 'userId', model: 'User' },
  'SalesPath.stages': { many: true, model: 'SalesPathStage', childFk: 'salesPathId', orderBy: { position: 'asc' } },
  'FlowDefinition.elements': { many: true, model: 'FlowElement', childFk: 'flowDefinitionId' },
};

/** Attach the manually resolved relations, one query per relation. */
async function hydrateIncludes(prisma, records, manual) {
  const rows = Array.isArray(records) ? records : records ? [records] : [];
  if (!rows.length || !manual.length) return records;

  for (const { key, fkField, delegate, select, many, childFk, orderBy } of manual) {
    if (many) {
      const parentIds = rows.map(r => r.id).filter(Boolean);
      const children = parentIds.length && prisma[delegate]?.findMany
        ? await prisma[delegate].findMany({
          where: { [childFk]: { in: parentIds } },
          ...(orderBy ? { orderBy } : {}),
          ...(select ? { select: { ...select, [childFk]: true } } : {}),
        }).catch(() => [])
        : [];
      for (const row of rows) row[key] = children.filter(c => c[childFk] === row.id);
      continue;
    }
    const ids = [...new Set(rows.map(r => r[fkField]).filter(Boolean))];
    let byId = new Map();
    if (ids.length && prisma[delegate]?.findMany) {
      const found = await prisma[delegate].findMany({
        where: { id: { in: ids } },
        ...(select ? { select: { ...select, id: true } } : {}),
      }).catch(() => []);
      byId = new Map(found.map(f => [f.id, f]));
    }
    for (const row of rows) row[key] = row[fkField] ? byId.get(row[fkField]) || null : null;
  }
  return records;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a path segment could be this model's id. A router's `/:id` routes
 * are registered before any the module adds, so `/count` or `/stats` used to
 * be read as an id and never reached their own handler.
 */
function looksLikeId(modelName, value) {
  const id = findModel(modelName)?.fields.find(f => f.isId);
  const generator = id?.default && typeof id.default === 'object' ? id.default.name : null;
  if (generator === 'uuid') return UUID.test(String(value));
  if (generator === 'cuid') return /^c[a-z0-9]{8,}$/i.test(String(value));
  if (id?.type === 'Int') return /^\d+$/.test(String(value));
  return true;
}

/**
 * Run a Prisma read or write whose `include` names relations the schema does
 * not declare, resolving those from their key columns afterwards.
 *
 *   queryWithIncludes(prisma, 'loginHistory', 'findMany', { where, include: { user: true } })
 */
async function queryWithIncludes(prisma, delegate, method, args = {}) {
  const { include, ...rest } = args;
  const { prismaInclude, manual } = resolveInclude(delegate, include);
  const result = await prisma[delegate][method]({ ...rest, ...(prismaInclude ? { include: prismaInclude } : {}) });
  await hydrateIncludes(prisma, result, manual);
  return result;
}

module.exports = { pickModelFields, modelHasField, resolveInclude, hydrateIncludes, looksLikeId, queryWithIncludes };
