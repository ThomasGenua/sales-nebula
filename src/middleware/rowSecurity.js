/**
 * Row-level security via security groups.
 *
 * A user can see a record when any of these hold:
 *   1. They are an admin (bypass).
 *   2. They own the record (ownerId / assignedId matches).
 *   3. The record is assigned to a security group they belong to,
 *      directly or through group inheritance.
 *   4. The module has no group assignments at all (unrestricted).
 *
 * The filter is applied as an additional Prisma `where` clause so it
 * composes with whatever the route already filters on.
 */

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

/** The ownership columns this model actually declares, via Prisma metadata. */
function ownerFieldsFor(prisma, modelName) {
  const fields = modelName && prisma[modelName]?.fields;
  if (!fields) return ['ownerId'];
  const present = OWNER_FIELDS.filter(f => f in fields);
  return present.length ? present : ['ownerId'];
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
        if (!opts.modelName || !prisma[opts.modelName]?.findUnique) return false;
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
  invalidateOrgWideDefaultCache, invalidateHierarchyCache, subordinateUserIds,
  rowSecurity, buildAccessFilter, applyAccessFilter,
  getUserGroupIds, expandGroupHierarchy, invalidateGroupCache,
  applyAutoAssignRules, autoAssignToUserGroups, isAdmin,
};
