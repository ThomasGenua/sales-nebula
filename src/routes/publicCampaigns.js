const router = require('express').Router();
const service = require('../services/campaignDelivery');
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex'
  });
  next();
});
router.all('/:id/unsubscribe', async (req, res, next) => {
  try {
    if (!['GET', 'POST'].includes(req.method)) return res.sendStatus(405);
    if (!service.validToken(req.params.id, req.query.token)) return res.sendStatus(404);
    if (req.method === 'GET') return res.type('html').send('<!doctype html><html lang="en"><title>Unsubscribe</title><h1>Stop marketing emails</h1><form method="post"><button>Unsubscribe</button></form></html>');
    res.send((await service.unsubscribe(req.app.locals.prisma, req.params.id)) ? 'You have been unsubscribed.' : 'Link not found');
  } catch (e) {
    next(e);
  }
});
module.exports = router;
