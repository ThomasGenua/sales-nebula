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

function isAdmin(user) {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  const role = String(user.role || user.roleName || '').toLowerCase();
  return role === 'admin' || role === 'administrator';
}

/**
 * Build the Prisma `where` fragment restricting a module to what the
 * user may see. Returns null when no restriction applies.
 */
async function buildAccessFilter(prisma, user, module, { minLevel = 'Read' } = {}) {
  if (isAdmin(user)) return null;

  // If nothing in this module is group-controlled, leave it open
  const controlled = await prisma.securityGroupRecord.findFirst({ where: { module }, select: { id: true } });
  if (!controlled) return null;

  const groupIds = await getUserGroupIds(prisma, user.id);

  const levels = minLevel === 'Full' ? ['Full'] : minLevel === 'Edit' ? ['Edit', 'Full'] : ['Read', 'Edit', 'Full'];

  const visible = groupIds.length
    ? await prisma.securityGroupRecord.findMany({
        where: { module, securityGroupId: { in: groupIds }, accessLevel: { in: levels } },
        select: { recordId: true },
      })
    : [];
  const visibleIds = visible.map(v => v.recordId);

  // Records nobody has assigned to a group stay visible
  const assigned = await prisma.securityGroupRecord.findMany({ where: { module }, select: { recordId: true } });
  const assignedIds = [...new Set(assigned.map(a => a.recordId))];

  const or = [
    { ownerId: user.id },
    { assignedId: user.id },
    { id: { in: visibleIds } },
    { id: { notIn: assignedIds } },
  ];

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
      if (!prisma || !req.user) return next();

      req.accessFilter = await buildAccessFilter(prisma, req.user, module, opts);

      req.canAccessRecord = async (recordId, level = 'Read') => {
        if (isAdmin(req.user)) return true;
        const groupIds = await getUserGroupIds(prisma, req.user.id);
        const levels = level === 'Full' ? ['Full'] : level === 'Edit' ? ['Edit', 'Full'] : ['Read', 'Edit', 'Full'];

        const assignments = await prisma.securityGroupRecord.findMany({ where: { module, recordId }, select: { securityGroupId: true, accessLevel: true } });
        if (!assignments.length) return true; // unrestricted record
        return assignments.some(a => groupIds.includes(a.securityGroupId) && levels.includes(a.accessLevel));
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
  rowSecurity, buildAccessFilter, applyAccessFilter,
  getUserGroupIds, expandGroupHierarchy, invalidateGroupCache,
  applyAutoAssignRules, autoAssignToUserGroups, isAdmin,
};
