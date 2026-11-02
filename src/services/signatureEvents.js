const crypto = require('crypto');
const TERMINAL = ['completed', 'declined', 'voided'];
const STATUSES = ['sent', 'delivered', ...TERMINAL];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function verify(raw, headers) {
  const keys = [process.env.DOCUSIGN_CONNECT_HMAC_KEY, process.env.DOCUSIGN_CONNECT_HMAC_KEY_PREVIOUS].filter(Boolean);
  if (!keys.length || !process.env.DOCUSIGN_ACCOUNT_ID) fail('DocuSign Connect is not configured', 503);
  if (!Buffer.isBuffer(raw)) fail('Expected the original JSON request body');
  const signatures = Object.entries(headers).filter(([name, value]) => /^x-docusign-signature-\d+$/i.test(name) && typeof value === 'string').map(([, value]) => Buffer.from(value, 'base64'));
  const valid = keys.some(key => {
    const expected = crypto.createHmac('sha256', key).update(raw).digest();
    return signatures.some(signature => signature.length === expected.length && crypto.timingSafeEqual(signature, expected));
  });
  if (!valid) fail('Invalid DocuSign signature', 401);
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { fail('Invalid JSON'); }
  if (event.data?.accountId !== process.env.DOCUSIGN_ACCOUNT_ID) fail('Wrong DocuSign account', 403);
  return event;
}

async function apply(db, row, status, occurredAt, reason = null, eventId = null) {
  if (!STATUSES.includes(status)) return { ignored: true };
  if (!(occurredAt instanceof Date) || !Number.isFinite(+occurredAt) || +occurredAt > Date.now() + 300000) fail('Invalid signature event date');
  try {
    return await db.$transaction(async tx => {
      if (eventId) await tx.signatureEvent.create({ data: { id: eventId, envelopeId: row.envelopeId, event: status, occurredAt } });
      const updated = await tx.signatureRequest.updateMany({
        where: { id: row.id, status: status === 'sent' ? { in: ['Pending', 'created', 'sent'] } : { notIn: TERMINAL }, OR: [{ statusChangedAt: null }, { statusChangedAt: { lt: occurredAt } }] },
        data: { status, statusChangedAt: occurredAt, statusReason: reason ? String(reason).slice(0, 500) : null, completedAt: status === 'completed' ? occurredAt : null, error: null },
      });
      if (updated.count && TERMINAL.includes(status)) {
        const room = await tx.dealRoom.findUnique({ where: { id: row.roomId } });
        const deal = room && await tx.deal.findUnique({ where: { id: room.dealId }, select: { id: true, ownerId: true } });
        const owner = deal?.ownerId && await tx.user.findUnique({ where: { id: deal.ownerId }, include: { role: { include: { permissions: true } } } });
        if (owner?.active && !owner.isPortalUser && require('../middleware/auth').permits({ user: owner }, 'deals', 'read')) {
          // No signer identity, amount or document content in the notification.
          await tx.notification.create({ data: { userId: owner.id, title: `Signature ${status}`, message: 'A signature request in your deal room changed. Review the signed quote version before taking the next step.', recordModule: 'deals', recordId: deal.id } });
        }
      }
      return { received: true, updated: !!updated.count };
    });
  } catch (e) {
    if (eventId && e.code === 'P2002') return { received: true, duplicate: true };
    throw e;
  }
}
async function receive(db, event) {
  const status = typeof event.event === 'string' && event.event.replace(/^envelope-/, '');
  if (!event.event?.startsWith('envelope-') || !STATUSES.includes(status)) return { received: true, ignored: true };
  const envelopeId = event.data?.envelopeId;
  if (typeof envelopeId !== 'string' || !envelopeId || envelopeId.length > 100) fail('Missing envelope ID');
  const row = await db.signatureRequest.findUnique({ where: { envelopeId } });
  // A non-2xx response asks Connect to retry a notification that beat send's commit.
  if (!row) fail('Envelope is not yet registered in Sales Nebula', 409);
  const summary = event.data.envelopeSummary || {};
  const at = new Date(summary.status === status && summary.statusChangedDateTime || event.generatedDateTime);
  const id = crypto.createHash('sha256').update(JSON.stringify([envelopeId, status, Number.isFinite(+at) ? at.toISOString() : null])).digest('hex');
  return apply(db, row, status, at, summary.voidedReason || summary.declinedReason, id);
}
module.exports = { verify, receive, apply };
