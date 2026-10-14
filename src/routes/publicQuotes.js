const { Router } = require('express');
const quotes = require('../services/customerQuotes');
const { updateRecord, runAfter } = require('../services/recordWrites');
const router = Router();
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }); next(); });
router.get('/:token', async (req, res, next) => {
  try { const item = await quotes.publicShare(req.app.locals.prisma, req.params.token); if (!item) return res.status(410).send('This quote link is unavailable. Ask the sender for an updated quote.'); res.type('html').send(quotes.html(item.share.snapshot, item.share, req.params.token)); } catch (e) { next(e); }
});
router.get('/:token/pdf', async (req, res, next) => {
  try { const item = await quotes.publicShare(req.app.locals.prisma, req.params.token); if (!item) return res.status(410).send('This quote link is unavailable.'); res.set('Content-Disposition', 'attachment; filename="quote.pdf"').type('pdf').send(await quotes.pdf(item.share.snapshot, item.share)); } catch (e) { next(e); }
});
router.post('/:token/accept', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma, name = String(req.body.name || '').trim(), email = String(req.body.email || '').trim().toLowerCase();
    if (!name || name.length > 150 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || ![true, 'yes'].includes(req.body.consent)) return res.status(400).send('Provide your full name and email, and confirm acceptance of the terms.');
    const after = [];
    const accepted = await db.$transaction(async tx => {
      const item = await quotes.publicShare(tx, req.params.token);
      if (!item) return false;
      if (item.share.acceptedAt) return true;
      const claim = await tx.quoteShare.updateMany({ where: { id: item.share.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date(), acceptedName: name, acceptedEmail: email } });
      if (!claim.count) throw Object.assign(new Error('This quote was already handled. Reload the link.'), { status: 409 });
      await updateRecord(tx, 'quotes', item.quote, { status: 'Accepted' }, { source: 'customer quote acceptance', expectedVersion: item.share.quoteVersion, after, prisma: db });
      return true;
    });
    if (!accepted) return res.status(410).send('This quote has changed or expired. Ask the sender for an updated quote.');
    await runAfter(after);
    res.redirect(303, '/api/public/quotes/' + req.params.token);
  } catch (e) { if (e.code === 'P2025') { e.status = 409; e.message = 'The quote changed. Ask the sender for an updated quote.'; } next(e); }
});
module.exports = router;
