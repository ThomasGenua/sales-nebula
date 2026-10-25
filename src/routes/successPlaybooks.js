const router = require('express').Router();
const {
  authenticate,
  requirePermission
} = require('../middleware/auth');
const {
  reachableWhere
} = require('../middleware/access');
const service = require('../services/successPlaybooks');
router.use(authenticate, requirePermission('accounts', 'read'));
router.get('/', async (req, res, next) => {
  try {
    res.json({
      data: await req.app.locals.prisma.successPlaybook.findMany({
        orderBy: {
          name: 'asc'
        }
      }),
      metrics: service.metrics
    });
  } catch (e) {
    next(e);
  }
});
router.post('/', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    service.validate(req.body);
    const {
      name,
      milestones,
      healthRules,
      riskThreshold
    } = req.body;
    res.status(201).json(await req.app.locals.prisma.successPlaybook.create({
      data: {
        name,
        milestones,
        healthRules,
        riskThreshold
      }
    }));
  } catch (e) {
    next(e);
  }
});
router.put('/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma,
      current = await db.successPlaybook.findUnique({
        where: {
          id: req.params.id
        }
      });
    if (!current) return res.sendStatus(404);
    const input = {
      ...current,
      ...req.body
    };
    service.validate(input);
    const {
      name,
      milestones,
      healthRules,
      riskThreshold,
      active
    } = input;
    res.json(await db.successPlaybook.update({
      where: {
        id: current.id
      },
      data: {
        name,
        milestones,
        healthRules,
        riskThreshold,
        active
      }
    }));
  } catch (e) {
    next(e);
  }
});
router.get('/accounts/:accountId', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    if (!(await db.account.findFirst({
      where: await reachableWhere(req, 'accounts', 'account', {
        id: req.params.accountId
      })
    }))) return res.sendStatus(404);
    const rows = await db.accountPlaybook.findMany({
        where: {
          accountId: req.params.accountId,
          ...(!require('../middleware/rowSecurity').isAdmin(req.user) && {
            ownerId: req.userId
          })
        }
      }),
      milestones = await db.playbookMilestone.findMany({
        where: {
          enrollmentId: {
            in: rows.map(r => r.id)
          }
        }
      });
    res.json({
      data: rows.map(r => ({
        ...r,
        milestones: milestones.filter(m => m.enrollmentId === r.id)
      }))
    });
  } catch (e) {
    next(e);
  }
});
router.post('/accounts/:accountId/enroll', requirePermission('accounts', 'edit'), async (req, res, next) => {
  try {
    res.status(201).json(await service.enroll(req.app.locals.prisma, req, req.params.accountId, String(req.body.playbookId)));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({
      error: 'Account already enrolled in this playbook'
    });
    next(e);
  }
});
router.post('/accounts/:accountId/evaluate', requirePermission('accounts', 'edit'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    if (!(await db.account.findFirst({
      where: await reachableWhere(req, 'accounts', 'account', {
        id: req.params.accountId
      }, 'Edit')
    }))) return res.sendStatus(404);
    const rows = await db.accountPlaybook.findMany({
      where: {
        accountId: req.params.accountId,
        ...(!require('../middleware/rowSecurity').isAdmin(req.user) && {
          ownerId: req.userId
        })
      }
    });
    const data = [];
    for (const row of rows) data.push(await service.evaluate(db, row));
    res.json({
      data
    });
  } catch (e) {
    next(e);
  }
});
module.exports = router;
