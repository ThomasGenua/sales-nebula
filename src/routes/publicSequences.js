const { Router } = require('express');
const { validToken } = require('../services/sequencePolicy');
const router = Router();
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }); next(); });
router.all('/:id/unsubscribe', async (req, res, next) => {
  try {
    if (!['GET', 'POST'].includes(req.method)) return res.sendStatus(405);
    if (!validToken(req.params.id, req.query.token)) return res.status(404).send('Link not found');
    const db = req.app.locals.prisma, enrollment = await db.emailSequenceEnrollment.findUnique({ where: { id: req.params.id } });
    if (!enrollment?.recipientEmail) return res.status(404).send('Link not found');
    if (req.method === 'GET') return res.type('html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><body><main><h1>Stop sequence emails</h1><p>Confirm to stop future sequence emails to this address.</p><form method="post"><button type="submit">Unsubscribe</button></form></main></body></html>');
    const email = enrollment.recipientEmail.toLowerCase();
    await db.$transaction(async tx => {
      await tx.emailSuppression.upsert({ where: { email }, create: { email, reason: 'Unsubscribe', source: 'sequence' }, update: { reason: 'Unsubscribe', expiresAt: null } });
      await tx.emailSequenceEnrollment.updateMany({ where: { OR: [{ id: enrollment.id }, { recipientEmail: email }], status: { in: ['Active', 'Paused'] } }, data: { status: 'Opted Out', nextSendAt: null } });
    });
    res.type('html').send('<!doctype html><html lang="en"><title>Unsubscribed</title><body><h1>You are unsubscribed</h1><p>Future sequence emails to this address have been stopped.</p></body></html>');
  } catch (e) { next(e); }
});
module.exports = router;
