const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createLimiter } = require('../middleware/rateLimit');
const marketing = require('../services/marketing');
const router = Router();
const limiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 90 });

router.post('/events', limiter, async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.dnt === '1' || req.headers['sec-gpc'] === '1' || process.env.MARKETING_ANALYTICS_ENABLED === 'false') return res.sendStatus(204);
  try {
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.sendStatus(403);
    await marketing.record(req.app.locals.prisma, req.body || {});
    res.sendStatus(204);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    next(error);
  }
});

router.get('/summary', authenticate, requirePermission('users', 'read'), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    res.json(await marketing.summary(req.app.locals.prisma, days));
  } catch (error) { next(error); }
});
module.exports = router;
