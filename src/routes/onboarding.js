const router = require('express').Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const service = require('../services/onboarding');
router.use(authenticate, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.get('/', wrap(async (req, res) => res.json(await service.status(req.app.locals.prisma, req))));
router.get('/pipeline', requirePermission('deals', 'read'), wrap(async (req, res) => res.json(await service.pipeline(req.app.locals.prisma))));
router.post('/pipeline', requirePermission('deals', 'read'), wrap(async (req, res) => res.json(await service.choosePipeline(req.app.locals.prisma, req))));
router.post('/visit', wrap(async (req, res) => { await service.visit(req.app.locals.prisma, req); res.json({ recorded: true }); }));
router.post('/preferences', wrap(async (req, res) => {
  const db = req.app.locals.prisma;
  if (Object.keys(req.body).some(k => !['dismissed', 'analyticsOptOut'].includes(k)) || Object.values(req.body).some(v => typeof v !== 'boolean')) return res.status(400).json({ error: 'Use boolean dismissed or analyticsOptOut preferences' });
  await service.ensure(db, req.userId);
  await db.$transaction(async tx => {
    await tx.userOnboarding.update({ where: { userId: req.userId }, data: { ...(req.body.dismissed !== undefined && { dismissedAt: req.body.dismissed ? new Date() : null }), ...(req.body.analyticsOptOut !== undefined && { analyticsOptOut: req.body.analyticsOptOut }) } });
    if (req.body.analyticsOptOut) await tx.userUsageDay.deleteMany({ where: { userId: req.userId } });
  });
  res.json({ saved: true });
}));
module.exports = router;
