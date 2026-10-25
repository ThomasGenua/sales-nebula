const crypto = require('crypto');
const router = require('express').Router();
const {
  authenticate,
  requirePermission,
  permits
} = require('../middleware/auth');
const {
  reachableWhere
} = require('../middleware/access');
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
router.use(authenticate, requirePermission('deals', 'read'));
async function roomFor(req, res, level = 'Read') {
  const db = req.app.locals.prisma,
    room = await db.dealRoom.findUnique({
      where: {
        id: req.params.id
      }
    });
  if (!room || !(await db.deal.findFirst({
    where: await reachableWhere(req, 'deals', 'deal', {
      id: room.dealId
    }, level)
  }))) {
    res.sendStatus(404);
    return null;
  }
  return room;
}
router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma,
      deals = await db.deal.findMany({
        where: await reachableWhere(req, 'deals', 'deal'),
        select: {
          id: true
        }
      });
    res.json({
      data: await db.dealRoom.findMany({
        where: {
          dealId: {
            in: deals.map(d => d.id)
          }
        },
        select: {
          id: true,
          name: true,
          dealId: true,
          expiresAt: true,
          revokedAt: true
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 200
      })
    });
  } catch (e) {
    next(e);
  }
});
router.post('/', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma,
      days = Number(req.body.days || 30);
    if (!Number.isInteger(days) || days < 1 || days > 90) return res.status(400).json({
      error: 'Choose 1–90 days'
    });
    const deal = await db.deal.findFirst({
      where: await reachableWhere(req, 'deals', 'deal', {
        id: String(req.body.dealId)
      }, 'Edit')
    });
    if (!deal) return res.sendStatus(404);
    const token = crypto.randomBytes(32).toString('hex'),
      room = await db.dealRoom.create({
        data: {
          dealId: deal.id,
          name: String(req.body.name || deal.name).slice(0, 200),
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + days * 86400000),
          createdById: req.userId
        }
      });
    res.status(201).json({
      id: room.id,
      url: (process.env.FRONTEND_URL || 'http://localhost:7544').split(',')[0] + '/api/public/deal-rooms/' + token
    });
  } catch (e) {
    next(e);
  }
});
router.get('/:id', async (req, res, next) => {
  try {
    const room = await roomFor(req, res);
    if (!room) return;
    const db = req.app.locals.prisma;
    res.json({
      room: {
        id: room.id,
        name: room.name,
        expiresAt: room.expiresAt,
        revokedAt: room.revokedAt
      },
      items: await db.dealRoomItem.findMany({
        where: {
          roomId: room.id
        },
        orderBy: {
          createdAt: 'asc'
        },
        take: 500
      }),
      signatures: permits(req, 'quotes', 'read') ? await db.signatureRequest.findMany({
        where: {
          roomId: room.id,
          quoteId: {
            in: (await db.quote.findMany({
              where: await reachableWhere(req, 'quotes', 'quote'),
              select: {
                id: true
              }
            })).map(q => q.id)
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      }) : [],
      docusignConfigured: !!require('../services/signatures').configured()
    });
  } catch (e) {
    next(e);
  }
});
router.post('/:id/revoke', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const room = await roomFor(req, res, 'Edit');
    if (!room) return;
    await req.app.locals.prisma.dealRoom.update({
      where: {
        id: room.id
      },
      data: {
        revokedAt: new Date()
      }
    });
    res.json({
      revoked: true
    });
  } catch (e) {
    next(e);
  }
});
router.post('/:id/items', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const room = await roomFor(req, res, 'Edit');
    if (!room) return;
    const {
      kind,
      title,
      body,
      url,
      dueDate
    } = req.body;
    if (!['document', 'milestone', 'comment'].includes(kind) || typeof title !== 'string' || !title.trim() || title.length > 200 || body && String(body).length > 10000) return res.status(400).json({
      error: 'Provide a valid item type, title and description'
    });
    if (kind === 'document') {
      try {
        if (new URL(url).protocol !== 'https:') throw 0;
      } catch {
        return res.status(400).json({
          error: 'Document links must use HTTPS'
        });
      }
    }
    if (dueDate && !Number.isFinite(Date.parse(dueDate))) return res.status(400).json({
      error: 'Invalid due date'
    });
    res.status(201).json(await req.app.locals.prisma.dealRoomItem.create({
      data: {
        roomId: room.id,
        kind,
        title,
        body: body || null,
        url: kind === 'document' ? url : null,
        dueDate: dueDate ? new Date(dueDate) : null,
        author: 'Sales team'
      }
    }));
  } catch (e) {
    next(e);
  }
});
router.post('/:id/items/:itemId/complete', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const room = await roomFor(req, res, 'Edit');
    if (!room) return;
    const result = await req.app.locals.prisma.dealRoomItem.updateMany({
      where: {
        id: req.params.itemId,
        roomId: room.id,
        kind: 'milestone'
      },
      data: {
        completedAt: req.body.completed === false ? null : new Date()
      }
    });
    res.json({
      updated: result.count
    });
  } catch (e) {
    next(e);
  }
});
router.post('/:id/signatures', requirePermission('deals', 'edit'), requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const room = await roomFor(req, res, 'Edit');
    if (!room) return;
    const db = req.app.locals.prisma,
      quote = await require('../services/customerQuotes').loadQuote(db, String(req.body.quoteId));
    if (!quote || quote.dealId !== room.dealId || !(await db.quote.findFirst({
      where: await reachableWhere(req, 'quotes', 'quote', {
        id: quote.id
      }, 'Edit')
    }))) return res.sendStatus(404);
    await require('../middleware/access').visibleLinks(req,'quote',quote,{account:true,contact:true,items:{include:{product:{select:{id:true,name:true}}}}});
    if ((await require('../services/fieldSecurity').policies(db)).some(p => p.module === 'quotes' && !p.visible)) return res.status(403).json({
      error: 'Full quote field access is required to share a signature document'
    });
    if (room.revokedAt || room.expiresAt <= new Date()) return res.status(400).json({
      error: 'Room is no longer active'
    });
    await require('../services/quotePricing').approvalRequired(db, quote, quote.items || [], quote);
    res.json(await require('../services/signatures').send(db, room, quote, req.body.name, req.body.email));
  } catch (e) {
    next(e);
  }
});
router.post('/:id/signatures/:signatureId/reconcile', requirePermission('deals', 'edit'), requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const room = await roomFor(req, res, 'Edit');
    if (!room) return;
    const db = req.app.locals.prisma,
      row = await db.signatureRequest.findFirst({
        where: {
          id: req.params.signatureId,
          roomId: room.id
        }
      });
    if (!row) return res.sendStatus(404);
    const quote = await db.quote.findFirst({
      where: await reachableWhere(req, 'quotes', 'quote', {
        id: row.quoteId
      }, 'Edit')
    });
    if (!quote) return res.sendStatus(404);
    res.json({
      ...(await require('../services/signatures').reconcile(db, row)),
      quoteChanged: +quote.updatedAt !== +row.quoteVersion
    });
  } catch (e) {
    next(e);
  }
});
router.post('/:id/proposals', requirePermission('deals', 'edit'), requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const room = await roomFor(req, res, 'Edit');
    if (!room) return;
    const db = req.app.locals.prisma,
      quote = await require('../services/customerQuotes').loadQuote(db, String(req.body.quoteId));
    if (!quote || quote.dealId !== room.dealId || !(await db.quote.findFirst({
      where: await reachableWhere(req, 'quotes', 'quote', {
        id: quote.id
      }, 'Edit')
    }))) return res.sendStatus(404);
    await require('../middleware/access').visibleLinks(req,'quote',quote,{account:true,contact:true,items:{include:{product:{select:{id:true,name:true}}}}});
    if ((await require('../services/fieldSecurity').policies(db)).some(p => p.module === 'quotes' && !p.visible)) return res.status(403).json({
      error: 'Full quote field access is required'
    });
    const snapshot = require('../services/customerQuotes').snapshot(quote, (await require('../utils/currency').currencyContext(db)).base);
    res.status(201).json(await db.dealRoomItem.create({
      data: {
        roomId: room.id,
        kind: 'proposal',
        title: 'Quote ' + quote.number,
        body: JSON.stringify(snapshot),
        author: 'Sales team'
      }
    }));
  } catch (e) {
    next(e);
  }
});
module.exports = router;
module.exports.hash = hash;
