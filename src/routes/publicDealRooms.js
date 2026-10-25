const router = require('express').Router();
const {
  hash
} = require('./dealRooms');
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);
router.use(require('express').urlencoded({
  extended: false,
  limit: '12kb'
}));
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  });
  next();
});
router.param('token', async (req, res, next, token) => {
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) return res.sendStatus(404);
    const db = req.app.locals.prisma,
      room = await db.dealRoom.findFirst({
        where: {
          tokenHash: hash(token),
          revokedAt: null,
          expiresAt: {
            gt: new Date()
          }
        }
      });
    if (!room || !(await db.deal.findFirst({
      where: {
        id: room.dealId,
        deletedAt: null
      },
      select: {
        id: true
      }
    }))) return res.sendStatus(404);
    req.room = room;
    next();
  } catch (e) {
    next(e);
  }
});
router.get('/:token', async (req, res, next) => {
  try {
    const items = await req.app.locals.prisma.dealRoomItem.findMany({
      where: {
        roomId: req.room.id
      },
      orderBy: {
        createdAt: 'asc'
      },
      take: 500
    });
    res.type('html').send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(req.room.name)}</title><style>body{font:16px system-ui;background:#f4f6fa;color:#18233c;margin:auto;max-width:850px;padding:32px}article,form{background:white;padding:20px;border:1px solid #ddd;border-radius:10px;margin:16px 0}textarea,input{display:block;box-sizing:border-box;width:100%;margin:8px 0;padding:10px}button{padding:10px 20px}p{white-space:pre-wrap}a{color:#164c9c}</style><main><h1>${escape(req.room.name)}</h1><p>Shared workspace · expires ${escape(req.room.expiresAt.toISOString().slice(0, 10))}</p>${items.map(i => `<article><h2>${escape(i.title)}</h2>${i.kind === 'proposal' ? `<a href="${escape(req.params.token)}/proposals/${i.id}">Download proposal PDF</a>` : `<p>${escape(i.body)}</p>`}${i.kind === 'document' ? `<a href="${escape(i.url)}" rel="noreferrer noopener" target="_blank">Open document</a>` : ''}${i.kind === 'milestone' ? `<p>${i.completedAt ? 'Completed' : 'Due ' + escape(i.dueDate?.toISOString().slice(0, 10) || 'date to be agreed')}</p><form method="post" action="${escape(req.params.token)}/milestones/${i.id}"><input type="hidden" name="completed" value="${i.completedAt ? 'false' : 'true'}"><button>${i.completedAt ? 'Reopen' : 'Mark complete'}</button></form>` : ''}<small>${escape(i.author)}</small></article>`).join('')}<form method="post" action="${escape(req.params.token)}/comments"><h2>Leave a comment</h2><label>Your name<input name="name" maxlength="100" required></label><label>Comment<textarea name="body" maxlength="5000" required></textarea></label><button>Post comment</button></form></main></html>`);
  } catch (e) {
    next(e);
  }
});
router.post('/:token/comments', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim(),
      body = String(req.body.body || '').trim();
    if (!name || name.length > 100 || !body || body.length > 5000) return res.status(400).send('Provide your name and a comment of up to 5,000 characters');
    const db = req.app.locals.prisma;
    if ((await db.dealRoomItem.count({
      where: {
        roomId: req.room.id
      }
    })) >= 500) return res.status(409).send('This workspace has reached its item limit');
    await db.dealRoomItem.create({
      data: {
        roomId: req.room.id,
        kind: 'comment',
        title: 'Customer comment',
        body,
        author: 'Customer: ' + name
      }
    });
    res.redirect(303, '/api/public/deal-rooms/' + req.params.token);
  } catch (e) {
    next(e);
  }
});
router.post('/:token/milestones/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma,
      item = await db.dealRoomItem.findFirst({
        where: {
          id: req.params.id,
          roomId: req.room.id,
          kind: 'milestone'
        }
      });
    if (!item) return res.sendStatus(404);
    await db.dealRoomItem.update({
      where: {
        id: item.id
      },
      data: {
        completedAt: req.body.completed === 'false' ? null : new Date()
      }
    });
    res.redirect(303, '/api/public/deal-rooms/' + req.params.token);
  } catch (e) {
    next(e);
  }
});
router.get('/:token/proposals/:id', async (req, res, next) => {
  try {
    const item = await req.app.locals.prisma.dealRoomItem.findFirst({
      where: {
        id: req.params.id,
        roomId: req.room.id,
        kind: 'proposal'
      }
    });
    if (!item) return res.sendStatus(404);
    res.type('application/pdf').send(await require('../services/customerQuotes').pdf(JSON.parse(item.body)));
  } catch (e) {
    next(e);
  }
});
module.exports = router;
