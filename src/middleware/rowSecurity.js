/**
 * Row-level security via security groups.
 *
 * A user can see a record when any of these hold:
 *   1. They are an admin (bypass).
 *   2. They own the record (ownerId / assignedId matches).
 *   3. The record is assigned to a security group they belong to,
 *      directly or through group inheritance.
 *   4. The record is shared with them (RecordShare), or a sharing rule
 *      that names them covers it.
 *   5. The module has no group assignments at all (unrestricted).
 *
 * The filter is applied as an additional Prisma `where` clause so it
 * composes with whatever the route already filters on.
 */

const { scalarWhere } = require('../utils/modelFields');

const GROUP_CACHE_TTL_MS = 60000;
const groupCache = new Map(); // userId -> { ids, expires }

/** Walk parent links so a child group's members inherit the parent's records. */
async function expandGroupHierarchy(prisma, groupIds) {
  if (!groupIds.length) return [];
  const all = new Set(groupIds);
  let frontier = [...groupIds];
  let guard = 0;

  while (frontier.length && guard++ < 20) {
    const groups = await prisma.securityGroup.findMany({
      where: { id: { in: frontier }, deletedAt: null },
      select: { id: true, parentGroupId: true, isNonInheritable: true },
    });
    const parents = groups
      .filter(g => g.parentGroupId && !g.isNonInheritable)
      .map(g => g.parentGroupId)
      .filter(id => !all.has(id));
    parents.forEach(id => all.add(id));
    frontier = parents;
  }
  return [...all];
}

/** Every group id a user effectively belongs to, including inherited. */
async function getUserGroupIds(prisma, userId, { useCache = true } = {}) {
  if (useCache) {
    const hit = groupCache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.ids;
  }

  const memberships = await prisma.securityGroupUser.findMany({
    where: { userId, securityGroup: { deletedAt: null, active: true } },
    select: { securityGroupId: true },
  });
  const direct = memberships.map(m => m.securityGroupId);
  const ids = await expandGroupHierarchy(prisma, direct);

  groupCache.set(userId, { ids, expires: Date.now() + GROUP_CACHE_TTL_MS });
  return ids;
}

/** Drop cached memberships for a user, or everyone when omitted. */
function invalidateGroupCache(userId) {
  if (userId) groupCache.delete(userId);
  else groupCache.clear();
}

const OWD_CACHE_TTL_MS = 60000;
let owdCache = { map: null, expires: 0 };

/**
 * The org-wide sharing default for each module.
 *
 * These were configurable in the admin UI, stored, seeded — and read by
 * nothing, so a module set to Private behaved exactly like one set to
 * ReadWrite. A sharing control that is not enforced is worse than none,
 * because it is believed.
 */
async function getOrgWideDefaults(prisma) {
  if (owdCache.map && owdCache.expires > Date.now()) return owdCache.map;
  const map = new Map();
  try {
    for (const row of await prisma.orgWideDefault.findMany()) map.set(row.module, row);
  } catch (err) { /* table absent; leave every module unrestricted */ }
  owdCache = { map, expires: Date.now() + OWD_CACHE_TTL_MS };
  return map;
}

function invalidateOrgWideDefaultCache() { owdCache = { map: null, expires: 0 }; }

const HIERARCHY_CACHE_TTL_MS = 60000;
let hierarchyCache = { children: null, expires: 0 };

/** Parent role id -> the role ids directly beneath it, from RoleHierarchy. */
async function getRoleChildren(prisma) {
  if (hierarchyCache.children && hierarchyCache.expires > Date.now()) return hierarchyCache.children;
  const children = new Map();
  try {
    for (const row of await prisma.roleHierarchy.findMany({ select: { roleId: true, parentId: true } })) {
      if (!row.parentId) continue;
      if (!children.has(row.parentId)) children.set(row.parentId, []);
      children.get(row.parentId).push(row.roleId);
    }
  } catch (err) { /* table absent; no hierarchy */ }
  hierarchyCache = { children, expires: Date.now() + HIERARCHY_CACHE_TTL_MS };
  return children;
}

function invalidateHierarchyCache() { hierarchyCache = { children: null, expires: 0 }; }

/**
 * The users in every role below this user's, however deep. A module whose
 * org-wide default grants access using the hierarchy lets a manager reach
 * what their reports own. `grantAccessUsing` was stored and read by nothing.
 */
async function subordinateUserIds(prisma, user) {
  const roleId = user.roleId || user.role?.id;
  if (!roleId) return [];
  const children = await getRoleChildren(prisma);
  const below = new Set();
  const queue = [...(children.get(roleId) || [])];
  while (queue.length) {
    const id = queue.shift();
    if (id === roleId || below.has(id)) continue; // a cycle ends the walk
    below.add(id);
    queue.push(...(children.get(id) || []));
  }
  if (!below.size) return [];
  const users = await prisma.user.findMany({ where: { roleId: { in: [...below] } }, select: { id: true } });
  return users.map(u => u.id);
}

const grantsViaHierarchy = owd => owd?.grantAccessUsing === 'hierarchy';

/**
 * Whether the org-wide default restricts this operation.
 *   Private  — only the owner (plus groups, plus admins) reads or writes.
 *   ReadOnly — anyone may read; only the owner may write.
 * Anything else, or no row at all, leaves the module open.
 */
function owdRestricts(owd, minLevel) {
  const access = owd?.internalAccess;
  if (access === 'Private') return true;
  if (access === 'ReadOnly') return minLevel === 'Edit' || minLevel === 'Full';
  return false;
}

function isAdmin(user) {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  // requirePermission attaches the full user, where `role` is the related Role
  // record. Stringifying that yields "[object Object]", so read .name first or
  // no administrator ever matches and admins get filtered like everyone else.
  const role = String(user.role?.name || user.role || user.roleName || '').toLowerCase();
  return role === 'admin' || role === 'administrator';
}

/** Ownership columns a record may carry. Not every model has both. */
const OWNER_FIELDS = ['ownerId', 'assignedId'];

/**
 * The ownership columns this model actually declares, via Prisma metadata.
 * A model with neither (a document) is owned by whoever created it, and one
 * with no such column at all has no owner, only group grants. Both used to
 * be filtered on an ownerId they do not have, which Prisma refuses, so every
 * restricted query on them failed.
 */
function ownerFieldsFor(prisma, modelName) {
  const fields = modelName && prisma[modelName]?.fields;
  if (!fields) return ['ownerId'];
  const present = OWNER_FIELDS.filter(f => f in fields);
  if (present.length) return present;
  return 'createdById' in fields ? ['createdById'] : [];
}

// ─── SHARING ───
// Records shared one at a time (RecordShare, /api/sharing/records) and by
// rule (SharingRule, /api/sharing/rules) were stored and read by nothing: a
// record shared with someone stayed out of their reach. A share or a rule
// adds access on top of ownership and groups; it never takes any away.

/** Share levels, as stored (lowercase), that satisfy a check at minLevel. */
const SHARE_LEVELS = { Read: ['read', 'edit', 'full'], Edit: ['edit', 'full'], Full: ['full'] };

const RULE_CACHE_TTL_MS = 60000;
let ruleCache = { byModule: null, expires: 0 };

/** Active sharing rules, by module. */
async function getSharingRules(prisma) {
  if (ruleCache.byModule && ruleCache.expires > Date.now()) return ruleCache.byModule;
  const byModule = new Map();
  try {
    for (const rule of await prisma.sharingRule.findMany({ where: { active: true } })) {
      if (!byModule.has(rule.module)) byModule.set(rule.module, []);
      byModule.get(rule.module).push(rule);
    }
  } catch (err) { /* table absent; no rules */ }
  ruleCache = { byModule, expires: Date.now() + RULE_CACHE_TTL_MS };
  return byModule;
}

function invalidateSharingRuleCache() { ruleCache = { byModule: null, expires: 0 }; }

/** A rule's `{ type: 'user' | 'role' | 'group', value }`, as lowercase values; value may be a list. */
const targetOf = target => ({
  type: String(target?.type || '').toLowerCase(),
  values: [].concat(target?.value ?? []).map(v => String(v).toLowerCase()),
});

/** Whether a rule's sharedTo names this user: by id, or their role or a group of theirs by id or name. */
async function ruleNamesUser(prisma, sharedTo, user) {
  const { type, values } = targetOf(sharedTo);
  if (!values.length) return false;
  if (type === 'user') return values.includes(String(user.id).toLowerCase());
  if (type === 'role') {
    const roleId = user.roleId || user.role?.id;
    let roleName = user.role?.name || (typeof user.role === 'string' ? user.role : user.roleName);
    if (!roleName && roleId) roleName = (await prisma.role.findUnique({ where: { id: roleId }, select: { name: true } }))?.name;
    return [roleId, roleName].some(v => v && values.includes(String(v).toLowerCase()));
  }
  if (type === 'group') {
    const groupIds = await getUserGroupIds(prisma, user.id);
    if (!groupIds.length) return false;
    const groups = await prisma.securityGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } });
    return groups.some(g => values.includes(g.id.toLowerCase()) || values.includes(String(g.name).toLowerCase()));
  }
  return false;
}

/** The users a rule's `{ type, value }` names: the user ids, or the members of the roles or groups. */
async function usersNamed(prisma, target) {
  const { type, values } = targetOf(target);
  if (!values.length) return [];
  if (type === 'user') return (await prisma.user.findMany({ where: { id: { in: values } }, select: { id: true } })).map(u => u.id);
  if (type === 'role') {
    const roles = (await prisma.role.findMany({ select: { id: true, name: true } }))
      .filter(r => values.includes(r.id.toLowerCase()) || values.includes(String(r.name).toLowerCase()));
    if (!roles.length) return [];
    return (await prisma.user.findMany({ where: { roleId: { in: roles.map(r => r.id) } }, select: { id: true } })).map(u => u.id);
  }
  if (type === 'group') {
    const groups = (await prisma.securityGroup.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }))
      .filter(g => values.includes(g.id.toLowerCase()) || values.includes(String(g.name).toLowerCase()));
    if (!groups.length) return [];
    const members = await prisma.securityGroupUser.findMany({ where: { securityGroupId: { in: groups.map(g => g.id) } }, select: { userId: true } });
    return [...new Set(members.map(m => m.userId))];
  }
  return [];
}

/** A criteria rule's `{ field, operator, value }` as a Prisma condition on that field, or null. */
const CRITERIA = {
  equals: v => v, eq: v => v,
  notequals: v => ({ not: v }), not_equals: v => ({ not: v }), neq: v => ({ not: v }),
  in: v => ({ in: [].concat(v) }),
  notin: v => ({ notIn: [].concat(v) }), not_in: v => ({ notIn: [].concat(v) }),
  contains: v => ({ contains: String(v) }),
  startswith: v => ({ startsWith: String(v) }), starts_with: v => ({ startsWith: String(v) }),
  greaterthan: v => ({ gt: v }), gt: v => ({ gt: v }), gte: v => ({ gte: v }),
  lessthan: v => ({ lt: v }), lt: v => ({ lt: v }), lte: v => ({ lte: v }),
};

/**
 * The records a rule shares, as a `where` on the module's model, or null for
 * none. criteria_based: the records matching sharedFrom's condition on one of
 * the model's own columns. owner_based: the records owned by the users
 * sharedFrom names, or with no sharedFrom, by the users the rule shares to (a
 * team seeing its own records). A rule that cannot be read shares nothing.
 */
async function ruleScope(prisma, rule, modelName) {
  const from = rule.sharedFrom && typeof rule.sharedFrom === 'object' && !Array.isArray(rule.sharedFrom) ? rule.sharedFrom : null;
  if (rule.type === 'criteria_based') {
    const build = from && CRITERIA[String(from.operator || 'equals').toLowerCase()];
    if (!build || typeof from.field !== 'string' || from.value === undefined) return null;
    const where = scalarWhere(modelName, { [from.field]: build(from.value) });
    return Object.keys(where).length ? where : null;
  }
  if (rule.type === 'owner_based') {
    const fields = ownerFieldsFor(prisma, modelName);
    const owners = await usersNamed(prisma, from || rule.sharedTo);
    if (!fields.length || !owners.length) return null;
    return { OR: fields.map(field => ({ [field]: { in: owners } })) };
  }
  return null;
}

/** `where` arms for the records of a module shared with the user at minLevel or above. */
async function sharedArms(prisma, user, module, modelName, minLevel = 'Read') {
  const levels = SHARE_LEVELS[minLevel] || SHARE_LEVELS.Read;
  const arms = [];
  const shares = await prisma.recordShare.findMany({
    where: { module, sharedWithId: user.id, accessLevel: { in: levels } },
    select: { recordId: true },
  }).catch(() => []);
  if (shares.length) arms.push({ id: { in: shares.map(s => s.recordId) } });
  if (!modelName) return arms;
  for (const rule of (await getSharingRules(prisma)).get(module) || []) {
    if (!levels.includes(String(rule.accessLevel || '').toLowerCase())) continue;
    if (!(await ruleNamesUser(prisma, rule.sharedTo, user))) continue;
    const scope = await ruleScope(prisma, rule, modelName);
    if (scope) arms.push(scope);
  }
  return arms;
}

/**
 * Build the Prisma `where` fragment restricting a module to what the
 * user may see. Returns null when no restriction applies.
 */
async function buildAccessFilter(prisma, user, module, { minLevel = 'Read', modelName } = {}) {
  if (isAdmin(user)) return null;

  const owd = (await getOrgWideDefaults(prisma)).get(module);
  const restricted = owdRestricts(owd, minLevel);

  // If nothing in this module is group-controlled and the org-wide default
  // does not restrict it either, leave it open.
  const controlled = await prisma.securityGroupRecord.findFirst({ where: { module }, select: { id: true } });
  if (!controlled && !restricted) return null;

  const groupIds = await getUserGroupIds(prisma, user.id);

  const levels = minLevel === 'Full' ? ['Full'] : minLevel === 'Edit' ? ['Edit', 'Full'] : ['Read', 'Edit', 'Full'];

  const visible = groupIds.length
    ? await prisma.securityGroupRecord.findMany({
        where: { module, securityGroupId: { in: groupIds }, accessLevel: { in: levels } },
        select: { recordId: true },
      })
    : [];
  const visibleIds = visible.map(v => v.recordId);

  // Contact, Deal and Account carry ownerId only; naming assignedId for those
  // makes Prisma throw on an unknown argument, so ask the model what it has.
  const or = [
    ...ownerFieldsFor(prisma, modelName).map(field => ({ [field]: user.id })),
    { id: { in: visibleIds } },
  ];

  if (grantsViaHierarchy(owd)) {
    const reports = await subordinateUserIds(prisma, user);
    if (reports.length) or.push(...ownerFieldsFor(prisma, modelName).map(field => ({ [field]: { in: reports } })));
  }

  or.push(...await sharedArms(prisma, user, module, modelName, minLevel));

  // Under an open org-wide default, a record nobody put in a group is nobody's
  // secret, so it stays visible. Under Private it does not.
  if (!restricted) {
    const assigned = await prisma.securityGroupRecord.findMany({ where: { module }, select: { recordId: true } });
    or.push({ id: { notIn: [...new Set(assigned.map(a => a.recordId))] } });
  }

  return { OR: or };
}

/**
 * Express middleware. Attaches req.accessFilter for the given module and
 * exposes req.canAccessRecord(recordId, level) for point checks.
 */
function rowSecurity(module, opts = {}) {
  return async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      if (!prisma) return next();

      // Only requirePermission attaches req.user. Routes that authenticate
      // without it would otherwise skip the filter entirely and silently
      // return every record, so load the user here instead of no-opping.
      if (!req.user && req.userId) {
        req.user = await prisma.user.findUnique({
          where: { id: req.userId },
          include: { role: true },
        });
      }
      if (!req.user) return next();

      req.accessFilter = await buildAccessFilter(prisma, req.user, module, opts);

      req.canAccessRecord = async (recordId, level = 'Read') => {
        if (isAdmin(req.user)) return true;
        // The list's own filter, applied to the one record. Checked apart, a
        // record a group held answered to the group alone, so its owner saw it
        // listed and got Not found opening it; and shares counted for neither.
        if (opts.modelName && prisma[opts.modelName]?.findFirst) {
          const filter = await buildAccessFilter(prisma, req.user, module, { minLevel: level, modelName: opts.modelName });
          if (!filter) return true;
          return !!(await prisma[opts.modelName].findFirst({ where: applyAccessFilter({ id: recordId }, filter), select: { id: true } }));
        }
        const groupIds = await getUserGroupIds(prisma, req.user.id);
        const levels = level === 'Full' ? ['Full'] : level === 'Edit' ? ['Edit', 'Full'] : ['Read', 'Edit', 'Full'];

        const assignments = await prisma.securityGroupRecord.findMany({ where: { module, recordId }, select: { securityGroupId: true, accessLevel: true } });
        if (assignments.length) {
          return assignments.some(a => groupIds.includes(a.securityGroupId) && levels.includes(a.accessLevel));
        }

        // No group holds this record, so the org-wide default decides.
        const owd = (await getOrgWideDefaults(prisma)).get(module);
        if (!owdRestricts(owd, level)) return true;

        const fields = ownerFieldsFor(prisma, opts.modelName);
        if (!fields.length || !opts.modelName || !prisma[opts.modelName]?.findUnique) return false;
        const record = await prisma[opts.modelName].findUnique({
          where: { id: recordId },
          select: Object.fromEntries(fields.map(f => [f, true])),
        }).catch(() => null);
        if (!record) return false;
        if (fields.some(f => record[f] === req.user.id)) return true;
        if (!grantsViaHierarchy(owd)) return false;
        const reports = await subordinateUserIds(prisma, req.user);
        return fields.some(f => record[f] && reports.includes(record[f]));
      };

      next();
    } catch (err) { next(err); }
  };
}

/** Merge the access filter into an existing where clause. */
function applyAccessFilter(where, accessFilter) {
  if (!accessFilter) return where;
  if (!where || !Object.keys(where).length) return accessFilter;
  return { AND: [where, accessFilter] };
}

/**
 * `where`, narrowed to the live records of a module the requesting user may
 * read. For summary endpoints that query a model directly, outside the CRUD
 * router's guards, and so used to count deleted and other people's records.
 */
async function visibleWhere(req, module, modelName, where = {}) {
  const prisma = req.app.locals.prisma;
  const filter = req.user ? await buildAccessFilter(prisma, req.user, module, { modelName }) : null;
  const live = prisma[modelName]?.fields?.deletedAt ? { deletedAt: null } : {};
  return applyAccessFilter({ ...where, ...live }, filter);
}

/**
 * Evaluate SecurityGroupRule conditions against a record and assign it
 * to the matching groups. Called after create/update.
 */
async function applyAutoAssignRules(prisma, module, record, { onCreate = true } = {}) {
  const rules = await prisma.securityGroupRule.findMany({
    where: { module, active: true, deletedAt: null, ...(onCreate ? { applyOnCreate: true } : { applyOnUpdate: true }) },
    orderBy: { priority: 'asc' },
  });
  if (!rules.length) return [];

  const applied = [];
  for (const rule of rules) {
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    const matches = conditions.every(c => {
      const actual = record[c.field];
      switch (c.operator) {
        case 'equals': return String(actual) === String(c.value);
        case 'notEquals': return String(actual) !== String(c.value);
        case 'contains': return String(actual || '').toLowerCase().includes(String(c.value).toLowerCase());
        case 'startsWith': return String(actual || '').toLowerCase().startsWith(String(c.value).toLowerCase());
        case 'greaterThan': return Number(actual) > Number(c.value);
        case 'lessThan': return Number(actual) < Number(c.value);
        case 'isEmpty': return actual === null || actual === undefined || actual === '';
        case 'isNotEmpty': return actual !== null && actual !== undefined && actual !== '';
        case 'in': return Array.isArray(c.value) && c.value.map(String).includes(String(actual));
        default: return false;
      }
    });

    if (matches && conditions.length) {
      await prisma.securityGroupRecord.create({
        data: { securityGroupId: rule.securityGroupId, module, recordId: record.id, accessLevel: 'Full' },
      }).catch(() => {}); // unique constraint means already assigned
      applied.push(rule.securityGroupId);
    }
  }
  return applied;
}

/** Assign a new record to the creator's primary groups when autoAssign is on. */
async function autoAssignToUserGroups(prisma, userId, module, recordId) {
  const memberships = await prisma.securityGroupUser.findMany({
    where: { userId, securityGroup: { deletedAt: null, active: true, autoAssign: true } },
    select: { securityGroupId: true },
  });
  for (const m of memberships) {
    await prisma.securityGroupRecord.create({
      data: { securityGroupId: m.securityGroupId, module, recordId, accessLevel: 'Full' },
    }).catch(() => {});
  }
  return memberships.length;
}

module.exports = {
  invalidateOrgWideDefaultCache, invalidateHierarchyCache, invalidateSharingRuleCache, subordinateUserIds,
  rowSecurity, buildAccessFilter, applyAccessFilter, visibleWhere,
  getUserGroupIds, expandGroupHierarchy, invalidateGroupCache,
  applyAutoAssignRules, autoAssignToUserGroups, isAdmin,
};
