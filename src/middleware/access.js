/**
 * Router-wide access checks, for routers whose routes belong to one module.
 *
 * A route guarded one at a time is only as safe as the last one somebody
 * remembered to guard. Routes added to a module after its CRUD basics (a
 * timeline, a merge, a clone, line items) were mostly left with
 * authenticate() alone, so a user with no access to the module read and
 * changed its records. These run for every route on the router they are
 * mounted on, including the ones added later.
 */
const { Prisma } = require('@prisma/client');
const { requirePermission, permits } = require('./auth');
const { buildAccessFilter, applyAccessFilter } = require('./rowSecurity');
const { looksLikeId, modelHasField } = require('../utils/modelFields');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The module's read permission to look, and its edit permission to change. */
function moduleAccess(module) {
  const readGate = requirePermission(module, 'read');
  const editGate = requirePermission(module, 'edit');
  return (req, res, next) => (SAFE_METHODS.has(req.method) ? readGate : editGate)(req, res, next);
}

/** Whether the user may see (or, with minLevel 'Edit', change) one record. */
async function canReach(req, module, modelName, id, minLevel = 'Read') {
  const prisma = req.app.locals.prisma;
  const filter = await buildAccessFilter(prisma, req.user, module, { minLevel, modelName });
  if (!filter) return true;
  const found = await prisma[modelName].findFirst({
    where: applyAccessFilter({ id: String(id) }, filter),
    select: { id: true },
  });
  return !!found;
}

/**
 * For router.param: the record a route names must be one the user may see,
 * or change for a write, by the module's row security; 404 otherwise, as for
 * a record that does not exist. A segment that is not an id (`/stats`)
 * passes to the route.
 */
function recordAccess(module, modelName) {
  return async (req, res, next, id) => {
    try {
      if (!looksLikeId(modelName, id)) return next();
      const minLevel = SAFE_METHODS.has(req.method) ? 'Read' : 'Edit';
      if (!(await canReach(req, module, modelName, id, minLevel))) return res.status(404).json({ error: 'Not found' });
      next();
    } catch (err) { next(err); }
  };
}

/**
 * `where`, narrowed to a module's live rows the user may see (minLevel
 * 'Read') or change ('Edit'), for queries and bulk writes outside the CRUD
 * router.
 */
async function reachableWhere(req, module, modelName, where = {}, minLevel = 'Read') {
  const prisma = req.app.locals.prisma;
  const filter = await buildAccessFilter(prisma, req.user, module, { minLevel, modelName });
  const live = modelHasField(modelName, 'deletedAt') ? { deletedAt: null } : {};
  return applyAccessFilter({ ...where, ...live }, filter);
}

/**
 * Why `data` may not link its record to the records its keys name, or null.
 * A key to another module's record (an activity's deal, a document's
 * account) must name a live record, in a module the caller may read, that
 * row security lets them see. Keys were stored as sent, so a record could be
 * filed on anyone's deal, and the hidden record's name read back through the
 * link. A key is a relation the schema declares, or a plain `<name>Id`
 * column naming a record module's model (an asset's accountId declares no
 * relation). Keys to tables outside the record modules (users, territories)
 * are left to the database. On an update, pass the record as it is: a key
 * that keeps its value is not a new link. A bulk write passes one `seen` Map
 * for all its rows, so each linked record is looked up once.
 */
async function linkRefusal(req, modelName, data, current = null, seen = new Map()) {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name.toLowerCase() === String(modelName).toLowerCase());
  if (!model || !data) return null;
  for (const [key, target] of linkKeys(model)) {
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    if (current && current[key] === value) continue;
    const module = moduleOf(target);
    if (!module) continue;
    const cacheKey = `${target}:${value}`;
    if (!seen.has(cacheKey)) {
      seen.set(cacheKey, permits(req, module, 'read') && !!(await req.app.locals.prisma[target].findFirst({
        where: await reachableWhere(req, module, target, { id: String(value) }),
        select: { id: true },
      })));
    }
    if (!seen.get(cacheKey)) return `${key} does not name a ${module.replace(/s$/, '')} you can see`;
  }
  return null;
}

// Record modules with routers of their own, outside the CRUD router.
const OWN_ROUTER_MODULES = { quote: 'quotes', invoice: 'invoices' };

/** The module whose records a model holds, or null. */
function moduleOf(target) {
  // Required here, not above: the CRUD router requires this file.
  const { crudModuleFor } = require('../utils/crud');
  return crudModuleFor(target) || OWN_ROUTER_MODULES[target] || null;
}

/** A model's link keys, key -> the linked model's delegate name. */
function linkKeys(model) {
  const keys = new Map();
  for (const field of model.fields) {
    if (field.kind === 'object' && field.relationFromFields?.length === 1) {
      keys.set(field.relationFromFields[0], field.type.charAt(0).toLowerCase() + field.type.slice(1));
    }
  }
  for (const field of model.fields) {
    if (field.kind !== 'scalar' || keys.has(field.name) || !/^[a-z][A-Za-z]*Id$/.test(field.name)) continue;
    const target = field.name.slice(0, -2);
    if (moduleOf(target)) keys.set(field.name, target);
  }
  return keys;
}

module.exports = { SAFE_METHODS, moduleAccess, recordAccess, canReach, reachableWhere, linkRefusal };
