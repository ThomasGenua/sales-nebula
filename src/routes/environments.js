const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { statusRoutes } = require('../utils/moduleStatus');
const { looksLikeId, columnsFrom } = require('../utils/modelFields');

const { unavailable } = require('../utils/unavailable');

const SANDBOXES = "Sandboxes are not available: no environment is provisioned or copied, and nothing is deployed to one.";

const router = Router();

// A segment that is not an id (`/count`) falls through to the routes below.
const idParam = (req, res, next) => (looksLikeId('environment', req.params.id) ? next() : next('route'));

// List environments
router.get('/', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const envs = await prisma.environment.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
    res.json(envs);
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, idParam, requirePermission('admin', 'read'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const env = await prisma.environment.findFirst({ where: { id: req.params.id, deletedAt: null } }); if (!env) return res.status(404).json({ error: 'Not found' }); res.json(env); } catch (err) { next(err); }
});

// An environment is a record of one, nothing more: nothing provisions or copies
// a sandbox, deploys to one, imports into one or rolls one back. Each of those
// answered as if it had (an environment "Active", a deployment "Completed" by
// a two-second timer, an import "queued", a rollback recorded); they now say
// so and change nothing. The list, export and history still answer.
router.post('/', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'SANDBOXES_UNAVAILABLE', `${SANDBOXES} No environment was created.`));

router.put('/:id', authenticate, idParam, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const env = await prisma.environment.update({ where: { id: req.params.id }, data: columnsFrom('environment', req.body) }); res.json(env); } catch (err) { next(err); }
});

router.delete('/:id', authenticate, idParam, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.environment.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

router.post('/:id/deploy', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'SANDBOXES_UNAVAILABLE', `${SANDBOXES} Nothing was deployed.`));

// Compare environments
router.get('/:id/compare', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { targetId } = req.query;
    if (!targetId) return res.status(400).json({ error: 'targetId query param required' });
    const [source, target] = await Promise.all([
      prisma.environment.findUnique({ where: { id: req.params.id } }),
      prisma.environment.findUnique({ where: { id: targetId } }),
    ]);
    if (!source || !target) return res.status(404).json({ error: 'One or both environments not found' });
    // An environment holds no metadata to compare (it read a column that does
    // not exist, and so reported 0 against 0 for any pair).
    unavailable(res, 'SANDBOXES_UNAVAILABLE', `${SANDBOXES} There is nothing in either environment to compare.`);
  } catch (err) { next(err); }
});

// Change sets
router.get('/change-sets', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const changeSets = await prisma.deployment.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    res.json(changeSets);
  } catch (err) { next(err); }
});

router.post('/change-sets', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'SANDBOXES_UNAVAILABLE', `${SANDBOXES} No change set was created.`));

// Metadata export/import
router.get('/metadata/export', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Flows are the Flow Builder's FlowDefinition rows; the Flow table read
    // here is written by nothing, so the export never carried a flow.
    const [customObjects, workflows, flows, validationRules] = await Promise.all([
      prisma.customObject.findMany({ where: { deletedAt: null } }),
      prisma.workflow.findMany(),
      prisma.flowDefinition.findMany(),
      prisma.validationRule.findMany().catch(() => []),
    ]);
    res.json({ exportedAt: new Date(), metadata: { customObjects, workflows, flows, validationRules } });
  } catch (err) { next(err); }
});

router.post('/metadata/import', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'SANDBOXES_UNAVAILABLE', "Importing metadata is not available. Nothing was imported or queued."));

module.exports = router;

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'environments', model: 'environment', analytics: true });

// Deployment history
router.get('/:id/deployments', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deployments = await prisma.deployment.findMany({ where: { environmentId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 20, include: { user: { select: { firstName: true, lastName: true } } } });
    res.json(deployments);
  } catch (err) { next(err); }
});

router.post('/:id/rollback', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'SANDBOXES_UNAVAILABLE', `${SANDBOXES} Nothing was rolled back.`));
