const payments = require('./payments');
const writes = require('./recordWrites');
const { acquireLease, releaseLease } = require('../utils/lease');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function inputData(input, kind) {
  if (!/^[a-f0-9-]{36}$/i.test(input.requestId || '')) fail('A unique request ID is required');
  const amountMinor = payments.minor(input.amount);
  if (!amountMinor) fail('Enter a positive amount');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) fail('Enter a reason shorter than 500 characters');
  return { reference: kind.toLowerCase() + ':' + input.requestId, amountMinor, reason: input.reason.trim() };
}
async function retryTransaction(db, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const after = [];
    try { const result = await db.$transaction(tx => fn(tx, after), { isolationLevel: 'Serializable', timeout: 20000 }); await writes.runAfter(after); return result; }
    catch (e) { if (!['P2034', 'P2002'].includes(e.code) || attempt === 2) throw e; }
  }
}
async function refreshInvoice(tx, invoice, ctx, after) {
  const b = await payments.balance(tx, invoice);
  if (invoice.status !== 'Cancelled') {
    const status = b.disputedMinor ? 'Disputed' : b.outstandingMinor === 0 ? 'Paid' : b.paidMinor ? 'Partially Paid' : invoice.status === 'Draft' ? 'Draft' : invoice.dueDate && invoice.dueDate < new Date() ? 'Overdue' : 'Sent';
    const paidDate = status === 'Paid' ? invoice.paidDate || new Date() : null;
    if (status !== invoice.status || +paidDate !== +invoice.paidDate) await writes.updateRecord(tx, 'invoices', invoice, { status, paidDate }, { ...ctx, after, source: 'billing adjustment reconciliation' });
  }
  return b;
}
async function creditNote(db, invoiceId, input, ctx) {
  const data = inputData(input, 'CreditNote');
  const note = await retryTransaction(db, async (tx, after) => {
    const prior = await tx.invoiceAdjustment.findUnique({ where: { reference: data.reference } });
    if (prior) { if (prior.invoiceId !== invoiceId || prior.amountMinor !== data.amountMinor || prior.reason !== data.reason) fail('Request ID already belongs to another adjustment', 409); return prior; }
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } }); if (!invoice) fail('Invoice not found', 404);
    const b = await payments.balance(tx, invoice);
    if (data.amountMinor > b.totalMinor) fail('Credit note exceeds the remaining invoice amount');
    const row = await tx.invoiceAdjustment.create({ data: { ...data, kind: 'CreditNote', invoiceId, currency: invoice.currency, status: 'Issued', createdById: ctx.userId } });
    await tx.auditLog.create({ data: { action: 'create', module: 'invoices', recordId: invoiceId, userId: ctx.userId, details: 'Issued credit note ' + row.id + ': ' + row.currency + ' ' + (row.amountMinor / 100).toFixed(2) } });
    await refreshInvoice(tx, invoice, { ...ctx, prisma: db }, after); return row;
  });
  const links = await db.paymentCheckout.findMany({ where: { invoiceId, status: 'Open' } });
  for (const link of links) {
    try {
      const session = await payments.stripe('checkout/sessions/' + encodeURIComponent(link.sessionId));
      if (session.status === 'open') await payments.stripe('checkout/sessions/' + encodeURIComponent(link.sessionId) + '/expire', {});
      if (session.payment_status === 'paid') await payments.reconcile(db, link.sessionId);
      else await db.paymentCheckout.update({ where: { id: link.id }, data: { status: 'Expired' } });
    } catch { await db.invoiceAdjustment.update({ where: { id: note.id }, data: { lastError: 'Credit issued, but a previous payment link could not be retired. Check existing Checkout sessions in Stripe before sharing another payment link.' } }); }
  }
  return db.invoiceAdjustment.findUnique({ where: { id: note.id } });
}
async function paymentIntent(db, payment) {
  if (payment.paymentIntentId) return payment.paymentIntentId;
  if (payment.provider !== 'stripe' || !payment.reference.startsWith('cs_')) fail('This receipt has no Stripe Checkout session', 409);
  const checkout = await db.paymentCheckout.findFirst({ where: { sessionId: payment.reference, invoiceId: payment.invoiceId } });
  if (!checkout) fail('This receipt cannot be linked to a Stripe Checkout session', 409);
  const session = await payments.stripe('checkout/sessions/' + encodeURIComponent(payment.reference));
  if (session.payment_status !== 'paid' || session.metadata?.checkoutId !== checkout.id || session.amount_total !== payment.amountMinor || session.currency !== payment.currency.toLowerCase() || typeof session.payment_intent !== 'string') fail('Stripe receipt identity does not match this invoice', 409);
  await db.$transaction([db.invoicePayment.update({ where: { id: payment.id }, data: { paymentIntentId: session.payment_intent } }), db.paymentCheckout.update({ where: { id: checkout.id }, data: { paymentIntentId: session.payment_intent } })]);
  return session.payment_intent;
}
const held = a => a.kind === 'Refund' ? ['Pending', 'pending', 'requires_action', 'succeeded'].includes(a.status) : a.kind === 'Dispute' && ['needs_response', 'under_review', 'lost'].includes(a.status);
async function refund(db, invoiceId, input, ctx) {
  const data = inputData(input, 'Refund');
  const payment = await db.invoicePayment.findFirst({ where: { id: String(input.paymentId || ''), invoiceId, provider: 'stripe' } }); if (!payment) fail('Choose a Stripe payment on this invoice', 404);
  const intent = await paymentIntent(db, payment);
  const result = await retryTransaction(db, async tx => {
    const prior = await tx.invoiceAdjustment.findUnique({ where: { reference: data.reference } });
    if (prior) { if (prior.paymentId !== payment.id || prior.amountMinor !== data.amountMinor || prior.reason !== data.reason) fail('Request ID already belongs to another refund', 409); return { row: prior, fresh: false }; }
    const adjustments = await tx.invoiceAdjustment.findMany({ where: { paymentId: payment.id } });
    if (data.amountMinor > payment.amountMinor - adjustments.filter(held).reduce((n, a) => n + a.amountMinor, 0)) fail('Refund exceeds the amount available after refunds and disputes');
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } }); if (!invoice) fail('Invoice not found', 404);
    const row = await tx.invoiceAdjustment.create({ data: { ...data, kind: 'Refund', invoiceId, paymentId: payment.id, currency: payment.currency, status: 'Pending', createdById: ctx.userId } });
    await tx.auditLog.create({ data: { action: 'create', module: 'invoices', recordId: invoiceId, userId: ctx.userId, details: 'Requested Stripe refund ' + row.id + ': ' + row.currency + ' ' + (row.amountMinor / 100).toFixed(2) } });
    return { row, fresh: true };
  });
  if (!result.fresh) return result.row;
  try {
    const refund = await payments.stripe('refunds', { payment_intent: intent, amount: String(data.amountMinor), 'metadata[adjustmentId]': result.row.id }, result.row.id);
    await webhook(db, { type: 'refund.updated', data: { object: refund } });
  } catch (e) {
    // A timeout can happen after Stripe accepts a refund. Preserve the reservation;
    // reconciliation reads Stripe and never submits the money movement a second time.
    await db.invoiceAdjustment.update({ where: { id: result.row.id }, data: { ...(e.providerStatus >= 400 && e.providerStatus < 500 && ![408, 409, 429].includes(e.providerStatus) && { status: 'failed' }), lastError: 'Refund confirmation is unavailable. Reconcile the ledger before retrying.', lastCheckedAt: new Date() } });
  }
  return db.invoiceAdjustment.findUnique({ where: { id: result.row.id } });
}
async function locatePayment(db, object) {
  let intent = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
  if (!intent && object.charge) { const charge = await payments.stripe('charges/' + encodeURIComponent(typeof object.charge === 'string' ? object.charge : object.charge.id)); intent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id; }
  if (!intent) return null;
  let payment = await db.invoicePayment.findUnique({ where: { paymentIntentId: intent } });
  if (!payment) {
    const sessions = await payments.stripe('checkout/sessions?payment_intent=' + encodeURIComponent(intent) + '&limit=10');
    for (const session of sessions.data || []) {
      const checkout = await db.paymentCheckout.findUnique({ where: { sessionId: session.id } });
      if (!checkout || session.metadata?.checkoutId !== checkout.id) continue;
      await payments.reconcile(db, session.id);
      const receipt = await db.invoicePayment.findUnique({ where: { reference: session.id } });
      if (receipt) { await paymentIntent(db, receipt); payment = await db.invoicePayment.findUnique({ where: { paymentIntentId: intent } }); break; }
    }
  }
  return payment;
}
async function synchronize(db, kind, object) {
  if (!object || typeof object.id !== 'string' || !Number.isSafeInteger(object.amount) || object.amount <= 0 || !['Refund', 'Dispute'].includes(kind)) fail('Invalid Stripe adjustment', 502);
  const payment = await locatePayment(db, object); if (!payment) return { ignored: true };
  if (object.amount > payment.amountMinor || object.currency !== payment.currency.toLowerCase()) fail('Stripe adjustment does not match the payment', 409);
  const statuses = kind === 'Refund' ? ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'] : ['warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost'];
  if (!statuses.includes(object.status)) fail('Unknown Stripe adjustment status', 502);
  const saved = await retryTransaction(db, async tx => {
    const invoice = await tx.invoice.findFirst({ where: { id: payment.invoiceId, deletedAt: null } }); if (!invoice) return { ignored: true };
    let existing = await tx.invoiceAdjustment.findUnique({ where: { providerId: object.id } });
    if (!existing && kind === 'Refund' && typeof object.metadata?.adjustmentId === 'string') existing = await tx.invoiceAdjustment.findUnique({ where: { id: object.metadata.adjustmentId } });
    if (existing && (existing.paymentId !== payment.id || existing.kind !== kind || existing.amountMinor !== object.amount || (existing.providerId && existing.providerId !== object.id))) fail('Provider adjustment metadata does not match the ledger', 409);
    const data = { status: object.status, providerId: object.id, lastCheckedAt: new Date(), lastError: null, ...(kind === 'Dispute' && { evidenceDueAt: Number.isSafeInteger(object.evidence_details?.due_by) ? new Date(object.evidence_details.due_by * 1000) : null }) };
    const row = existing ? await tx.invoiceAdjustment.update({ where: { id: existing.id }, data }) : await tx.invoiceAdjustment.create({ data: { ...data, kind, invoiceId: invoice.id, paymentId: payment.id, amountMinor: object.amount, currency: payment.currency, reason: String(object.reason || 'Stripe adjustment').slice(0, 500), reference: 'stripe:' + object.id } });
    return row;
  });
  if (saved.ignored) return saved;
  try { await retryTransaction(db, async (tx, after) => { const invoice = await tx.invoice.findUnique({ where: { id: payment.invoiceId } }); await refreshInvoice(tx, invoice, { prisma: db }, after); }); }
  catch { await db.invoiceAdjustment.update({ where: { id: saved.id }, data: { lastError: 'Provider adjustment recorded. Invoice status could not be updated; review its validation rules and reconcile again.' } }); }
  return db.invoiceAdjustment.findUnique({ where: { id: saved.id } });
}
async function webhook(db, event) {
  const kind = event.type.startsWith('charge.dispute.') ? 'Dispute' : event.type.startsWith('refund.') ? 'Refund' : null;
  if (!kind || typeof event.data?.object?.id !== 'string') return { ignored: true };
  const key = 'stripe-adjustment:' + event.data.object.id, lease = await acquireLease(db, key, 60000);
  if (!lease) fail('This adjustment is being reconciled; retry delivery', 409);
  try { return await synchronize(db, kind, await payments.stripe((kind === 'Refund' ? 'refunds/' : 'disputes/') + encodeURIComponent(event.data.object.id))); }
  finally { await releaseLease(db, key, lease); }
}
async function listAll(path, intent) {
  const rows = []; let cursor;
  for (let page = 0; page < 20; page++) {
    const data = await payments.stripe(path + '?payment_intent=' + encodeURIComponent(intent) + '&limit=100' + (cursor ? '&starting_after=' + encodeURIComponent(cursor) : ''));
    if (!Array.isArray(data.data)) fail('Invalid Stripe reconciliation response', 502);
    rows.push(...data.data); if (!data.has_more) return rows;
    cursor = data.data.at(-1)?.id; if (!cursor) break;
  }
  fail('This payment has too many adjustments for one reconciliation. Contact support.', 409);
}
async function reconcileInvoice(db, invoiceId) {
  const rows = await db.invoicePayment.findMany({ where: { invoiceId, provider: 'stripe' } });
  for (const payment of rows) {
    const intent = await paymentIntent(db, payment);
    for (const [kind, resource] of [['Refund', 'refunds'], ['Dispute', 'disputes']]) {
      for (const object of await listAll(resource, intent)) {
        // Fetch inside the same lease as webhooks so an older list page cannot
        // overwrite a newer provider status committed by a concurrent callback.
        await webhook(db, { type: kind === 'Refund' ? 'refund.updated' : 'charge.dispute.updated', data: { object } });
      }
    }
    await db.invoiceAdjustment.updateMany({ where: { paymentId: payment.id, status: 'Pending', providerId: null }, data: { lastCheckedAt: new Date(), lastError: 'No matching refund found at Stripe yet. The request has not been resubmitted. Verify it in Stripe before initiating a separate refund.' } });
  }
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } }); return payments.balance(db, invoice);
}
async function processDue(db) {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const rows = await db.invoiceAdjustment.findMany({ where: { kind: { in: ['Refund', 'Dispute'] }, status: { in: ['Pending', 'pending', 'requires_action', 'needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'] }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - 15 * 60000) } }] }, orderBy: { updatedAt: 'asc' }, take: 10 });
  for (const invoiceId of [...new Set(rows.map(r => r.invoiceId))]) {
    try { await reconcileInvoice(db, invoiceId); } catch { await db.invoiceAdjustment.updateMany({ where: { invoiceId, id: { in: rows.map(r => r.id) } }, data: { lastCheckedAt: new Date(), lastError: 'Stripe reconciliation failed. Check the provider connection and retry.' } }); }
  }
}
module.exports = { inputData, creditNote, refund, synchronize, webhook, reconcileInvoice, processDue, paymentIntent };
