const { Prisma } = require('@prisma/client');

/**
 * No write reaches the access tables by way of another table.
 *
 * Prisma takes nested writes down any relation, so a request body passed to a
 * write whole could reach a record's users and through them roles:
 * `createdBy: { update: { role: { update: { name: 'Admin' } } } }` on a report
 * renamed its author's role to Admin, and isAdmin() goes by the role's name.
 * Routes keep bodies to a model's own columns (pickModelFields, columnsFrom),
 * and this holds for any that do not.
 *
 * Users, roles, permissions, keys, tokens and security groups change through
 * their own routes, as top-level writes. Nested inside another model's write,
 * they may only be linked or unlinked (connect, disconnect), never created,
 * changed or deleted. Nothing in the app writes them any other way.
 */
const GUARDED = new Set([
  'User', 'Role', 'Permission', 'RoleHierarchy', 'FieldPermission', 'OrgWideDefault',
  'ApiKey', 'ConnectedApp', 'OAuthToken', 'OAuthAuthorizationCode', 'SsoConfig', 'MfaDevice',
  'PortalUser', 'UserInvite', 'SignupRequest',
  'SecurityGroup', 'SecurityGroupUser', 'SecurityGroupRecord', 'SecurityGroupRole', 'SecurityGroupRule',
]);

const MODELS = new Map(Prisma.dmmf.datamodel.models.map(m => [m.name, m]));
const LINK_ONLY = new Set(['connect', 'disconnect']);
const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);
const MAX_DEPTH = 16;

const list = value => (value === undefined || value === null ? [] : [].concat(value));

/** The rows a nested operation writes into its relation's model. */
function rowsOf(operation, payload) {
  switch (operation) {
    case 'create': return list(payload);
    case 'createMany': return list(payload?.data);
    case 'connectOrCreate': return list(payload).map(p => p?.create);
    case 'update':
    case 'updateMany': return list(payload).flatMap(p => [p, p?.data]);
    case 'upsert': return list(payload).flatMap(p => [p?.create, p?.update, p?.update?.data]);
    default: return [];
  }
}

/** Where, in rows written to `modelName`, a nested write reaches an access table; null if nowhere. */
function breach(modelName, rows, path, depth = 0) {
  const model = MODELS.get(modelName);
  if (!model) return null;
  for (const row of list(rows)) {
    if (!row || typeof row !== 'object') continue;
    for (const field of model.fields) {
      if (field.kind !== 'object') continue;
      const nested = row[field.name];
      if (!nested || typeof nested !== 'object') continue;
      for (const [operation, payload] of Object.entries(nested)) {
        const at = `${path}.${field.name}.${operation}`;
        if (GUARDED.has(field.type) && !LINK_ONLY.has(operation)) return at;
        if (depth >= MAX_DEPTH) return at;
        const deeper = breach(field.type, rowsOf(operation, payload), at, depth + 1);
        if (deeper) return deeper;
      }
    }
  }
  return null;
}

/** For a top-level write, where it reaches an access table through another; null if it does not. */
function nestedWriteRefusal(model, operation, args) {
  if (!WRITES.has(operation) || GUARDED.has(model)) return null;
  const rows = operation === 'upsert' ? [args?.create, args?.update] : list(args?.data);
  return breach(model, rows, model);
}

class NestedWriteRefused extends Error {
  constructor(at) {
    super(`A write through ${at} is not allowed: users, roles and access settings change through their own routes`);
    this.status = 400;
    this.code = 'NESTED_WRITE_REFUSED';
  }
}

/** The client, refusing any write that reaches an access table through another table. */
function guardNestedWrites(prisma) {
  return prisma.$extends({
    name: 'nestedWriteGuard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const at = nestedWriteRefusal(model, operation, args);
          if (at) throw new NestedWriteRefused(at);
          return query(args);
        },
      },
    },
  });
}

module.exports = { guardNestedWrites, nestedWriteRefusal, NestedWriteRefused, GUARDED };
