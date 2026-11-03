const { Router } = require('express');
module.exports = db => {
  const router = Router(), service = require('../services/mailboxCompletion');
  router.post('/microsoft', async (req, res, next) => {
    if (typeof req.query.validationToken === 'string' && req.query.validationToken.length < 2000) return res.type('text/plain').send(req.query.validationToken);
    try { await service.microsoftNotification(db, req.body.value); res.sendStatus(202); } catch (e) { next(e); }
  });
  router.post('/google', async (req, res, next) => {
    try { await service.googleNotification(db, req); res.sendStatus(204); } catch (e) { next(e); }
  });
  return router;
};
