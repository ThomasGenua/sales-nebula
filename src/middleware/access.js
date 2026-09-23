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
const { requirePermission } = require('./auth');
const { buildAccessFilter, applyAccessFilter } = require('./rowSecurity');
const { looksLikeId } = require('../utils/modelFields');

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

module.exports = { SAFE_METHODS, moduleAccess, recordAccess, canReach };
