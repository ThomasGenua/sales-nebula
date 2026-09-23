/**
 * GET /count, /status/health and (optionally) /analytics/summary for a module.
 *
 * Thirteen route files carried these as copied stubs. The count was always
 * 0. The health check said healthy without checking anything, under a
 * made-up version number. The "analytics" reported the Node process's uptime
 * and memory. These answer from the module's own table, counting only live
 * records the caller may see.
 */
const { authenticate } = require('../middleware/auth');
const { visibleWhere } = require('../middleware/rowSecurity');

function statusRoutes(router, { module, model = null, where = {}, analytics = false }) {
  const scoped = req => visibleWhere(req, module, model, where);

  if (model) {
    router.get('/count', authenticate, async (req, res, next) => {
      try {
        res.json({ count: await req.app.locals.prisma[model].count({ where: await scoped(req) }), module });
      } catch (err) { next(err); }
    });
  }

  router.get('/status/health', authenticate, async (req, res) => {
    const prisma = req.app.locals.prisma;
    const checkedAt = new Date();
    try {
      if (model) await prisma[model].findFirst({ select: { id: true } });
      else await prisma.$queryRaw`SELECT 1`;
      res.json({ module, healthy: true, checkedAt });
    } catch (err) {
      res.status(503).json({ module, healthy: false, checkedAt, error: 'Database unavailable' });
    }
  });

  if (model && analytics) {
    router.get('/analytics/summary', authenticate, async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const base = await scoped(req);
        const since = new Date(Date.now() - 30 * 86400000);
        const [total, recent] = await Promise.all([
          prisma[model].count({ where: base }),
          prisma[model].fields?.createdAt ? prisma[model].count({ where: { AND: [base, { createdAt: { gte: since } }] } }) : null,
        ]);
        res.json({ module, total, createdLast30Days: recent, checkedAt: new Date() });
      } catch (err) { next(err); }
    });
  }
}

module.exports = { statusRoutes };
