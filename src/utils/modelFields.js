const { Prisma } = require('@prisma/client');

/**
 * Keep only the scalar keys a model actually declares.
 *
 * Routes that spread req.body into a Prisma write turn any stray key into a
 * 500 — and worse, Prisma then reports the *wrong* field, because one unknown
 * key stops it matching the unchecked-create input type and it complains about
 * the relation scalars instead. A client sending `assigneeId` for `assignedId`
 * got "Unknown argument `dealId`".
 *
 * Relation keys are dropped too. Kept "so nested writes still work", they let
 * a request reach any table joined to the record: on a deal, `{ owner: {
 * update: { role: ... } } }` changed its owner's role, and longer chains went
 * anywhere. A route that needs a nested write builds it from fields it has
 * checked (see lineItemFields). Ignored keys are returned rather than dropped
 * in silence.
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
    if (!field || field.kind === 'object') { ignored.push(key); continue; }
    kept[key] = coerce(field, value);
  }
  return { data: kept, ignored };
}

/**
 * A quote, invoice or order line from a request, as the columns those item
 * tables share, and nothing else. `price` and `name` are read as unitPrice
 * and description, which is what the items actually store.
 */
function lineItemFields(item, { discount = true } = {}) {
  const i = item && typeof item === 'object' ? item : {};
  const quantity = Number.isInteger(Number(i.quantity)) && Number(i.quantity) > 0 ? Number(i.quantity) : 1;
  const unitPrice = Number(i.unitPrice ?? i.price) || 0;
  const off = discount ? Number(i.discount) || 0 : 0;
  return {
    productId: i.productId ? String(i.productId) : null,
    description: i.description ?? i.name ?? null,
    quantity,
    unitPrice,
    ...(discount && { discount: off }),
    total: quantity * unitPrice - off,
  };
}

// A field an automated update (an approval's final action, a workflow) may
// set: a plain value, never who owns or links to a record, its identity or
// its timestamps. Those would let a rule hand records to someone else, and a
// value that is an object would be a nested write into another table.
const PROTECTED_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'ownerId', 'assignedId', 'createdById']);
const VALUE_TYPES = { String: 'string', Int: 'number', Float: 'number', Decimal: 'number', Boolean: 'boolean' };

/**
 * A caller's values for a model's own columns, less its identity, its
 * timestamps and who owns it, for bulk writes where ownership is the server's
 * to set (or a reassignment's).
 */
function editableFields(modelName, data) {
  const { data: picked } = pickModelFields(modelName, data || {});
  for (const key of PROTECTED_FIELDS) delete picked[key];
  return picked;
}

/**
 * A request body as the model's own columns, less its id and timestamps, for
 * routes that passed the body to a write whole. A relation key in it was a
 * nested write into another table (an email's `deal: { update: … }` rewrote
 * a deal the caller could not open), and `id` renamed the row.
 */
function columnsFrom(modelName, body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const { data } = pickModelFields(modelName, source);
  for (const key of ['id', 'createdAt', 'updatedAt']) delete data[key];
  return data;
}

/** Why an automated update may not set `field` to `value` on a model, or null. */
function plainFieldProblem(modelName, field, value) {
  const model = findModel(modelName);
  if (!model) return `There is no ${modelName} model`;
  const foreignKeys = new Set(model.fields.flatMap(f => f.relationFromFields || []));
  const def = model.fields.find(f => f.name === field);
  if (!def || def.kind === 'object' || def.isId || def.isUpdatedAt || foreignKeys.has(field)
      || PROTECTED_FIELDS.has(field) || /Id$/.test(field)) {
    return `"${field}" is not a field an automated update may set`;
  }
  if (value === null || value === undefined) return def.isRequired ? `${field} cannot be emptied` : null;
  if (def.kind === 'enum') {
    const values = Prisma.dmmf.datamodel.enums.find(e => e.name === def.type)?.values.map(v => v.name) || [];
    return values.includes(value) ? null : `${field} must be one of: ${values.join(', ')}`;
  }
  const expected = VALUE_TYPES[def.type];
  if (!expected) return `${field} is a ${def.type}, which an automated update cannot set`;
  if (typeof value !== expected || (def.type === 'Int' && !Number.isInteger(value))) {
    return `${field} needs a ${def.type === 'Int' ? 'whole number' : expected} value`;
  }
  return null;
}

// ─── A CALLER'S OWN FILTERS AND SELECTIONS ───

const FILTER_OPS = new Set(['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode']);
const plain = v => v === null || ['string', 'number', 'boolean'].includes(typeof v) || v instanceof Date;

/**
 * A caller-supplied `where`, kept to the model's own scalar columns and plain
 * comparisons; everything else is dropped. A relation filter such as
 * `{ owner: { password: { startsWith: '$2a$12$a' } } }` let a query probe rows
 * it never returned, a user's password hash included, a character at a time.
 */
function scalarWhere(modelName, where) {
  const model = findModel(modelName);
  const out = {};
  if (!model || !where || typeof where !== 'object' || Array.isArray(where)) return out;
  for (const [key, value] of Object.entries(where)) {
    const field = model.fields.find(f => f.name === key);
    if (!field || field.kind === 'object') continue;
    if (plain(value)) { out[key] = value; continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const condition = {};
    for (const [op, v] of Object.entries(value)) {
      if (!FILTER_OPS.has(op)) continue;
      if (op === 'in' || op === 'notIn') { if (Array.isArray(v) && v.every(plain)) condition[op] = v; }
      else if (op === 'mode') { if (v === 'insensitive' || v === 'default') condition[op] = v; }
      else if (plain(v)) condition[op] = v;
    }
    if (Object.keys(condition).length) out[key] = condition;
  }
  return out;
}

/**
 * A caller's sort as a Prisma `orderBy` on one of the model's own scalar
 * columns, or null. A relation name here sorted by the related record's
 * columns, which a caller should not be able to reach.
 */
function scalarOrderBy(modelName, field, direction) {
  const model = findModel(modelName);
  const column = model?.fields.find(f => f.name === field && f.kind !== 'object');
  return column ? { [column.name]: direction === 'asc' ? 'asc' : 'desc' } : null;
}

/**
 * A caller's choice of columns as a Prisma `select`: the model's own scalar
 * fields only (id always). A relation in `select` returned the related rows,
 * so `{ owner: { select: { password: true } } }` read password hashes. Takes
 * a list of names or a `{ name: true }` object; undefined when none remain.
 */
function scalarSelect(modelName, fields) {
  const model = findModel(modelName);
  const names = Array.isArray(fields) ? fields : fields && typeof fields === 'object' ? Object.keys(fields).filter(k => fields[k]) : [];
  const picked = names.filter(n => model?.fields.some(f => f.name === n && f.kind !== 'object'));
  return picked.length ? Object.fromEntries([['id', true], ...picked.map(n => [n, true])]) : undefined;
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
const SAFE_USER_SELECT = { id: true, firstName: true, lastName: true, email: true, avatar: true };

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
      // A user comes back as who they are, never whole: a bare include of an
      // owner or assignee would otherwise carry their password hash out.
      const shape = select ? { ...select, id: true } : delegate === 'user' ? SAFE_USER_SELECT : null;
      const found = await prisma[delegate].findMany({
        where: { id: { in: ids } },
        ...(shape ? { select: shape } : {}),
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

module.exports = {
  pickModelFields, lineItemFields, plainFieldProblem, editableFields, columnsFrom, scalarWhere, scalarSelect, scalarOrderBy,
  modelHasField, resolveInclude, hydrateIncludes, looksLikeId, queryWithIncludes,
};
