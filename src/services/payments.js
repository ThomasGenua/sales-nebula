const crypto = require('crypto');
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), {
    status
  });
};
const minor = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100)) || Math.round(n * 100) > 2147483647) fail('Amount must be a finite nonnegative currency amount');
  return Math.round(n * 100);
};
// Explicit two-decimal currencies; do not silently charge JPY or other exponents incorrectly.
const currencies = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'CHF'];
async function balance(db, invoice) {
  const payments = await db.invoicePayment.findMany({
    where: {
      invoiceId: invoice.id
    },
    orderBy: {
      createdAt: 'asc'
    }
  });
  const paidMinor = payments.reduce((n, p) => n + p.amountMinor, 0),
    totalMinor = minor(invoice.total);
  return {
    currency: invoice.currency,
    totalMinor,
    paidMinor,
    outstandingMinor: Math.max(0, totalMinor - paidMinor),
    creditMinor: Math.max(0, paidMinor - totalMinor),
    payments
  };
}
async function recordPayment(db, invoiceId, input, ctx = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const after = [];
    try {
      const result = await db.$transaction(async tx => {
        const prior = await tx.invoicePayment.findUnique({
          where: {
            reference: input.reference
          }
        });
        if (prior) {
          if (prior.invoiceId !== invoiceId || prior.amountMinor !== input.amountMinor || prior.currency !== input.currency) fail('Payment reference already belongs to another payment', 409);
          return prior;
        }
        const invoice = await tx.invoice.findFirst({
          where: {
            id: invoiceId,
            deletedAt: null
          }
        });
        if (!invoice) fail('Invoice not found', 404);
        if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 2147483647 || invoice.currency !== input.currency) fail('Payment amount or currency is invalid');
        const current = await balance(tx, invoice);
        if (input.provider === 'manual' && input.amountMinor > current.outstandingMinor) fail('Payment exceeds the outstanding balance');
        const payment = await tx.invoicePayment.create({
          data: {
            invoiceId,
            ...input
          }
        });
        await require('./recordWrites').updateRecord(tx, 'invoices', invoice, {
          status: current.paidMinor + input.amountMinor >= current.totalMinor ? 'Paid' : 'Partially Paid',
          paidDate: current.paidMinor + input.amountMinor >= current.totalMinor ? new Date() : null,
          payMethod: input.provider === 'stripe' ? 'Credit Card' : 'Manual'
        }, {
          ...ctx,
          prisma: db,
          after,
          source: 'payment reconciliation'
        });
        return payment;
      }, {
        isolationLevel: 'Serializable'
      });
      await require('./recordWrites').runAfter(after);
      return result;
    } catch (e) {
      if (!['P2034', 'P2002'].includes(e.code) || attempt === 2) throw e;
    }
  }
}
async function stripe(path, body, idempotency) {
  if (!process.env.STRIPE_SECRET_KEY) fail('Stripe is not configured', 503);
  const response = await fetch('https://api.stripe.com/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
      ...(body && {
        'Content-Type': 'application/x-www-form-urlencoded'
      }),
      ...(idempotency && {
        'Idempotency-Key': idempotency
      })
    },
    ...(body && {
      body: new URLSearchParams(body)
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok) fail(data.error?.message || 'Stripe request failed', 502);
  return data;
}
async function checkout(db, invoice, userId, amount) {
  if (!process.env.STRIPE_SECRET_KEY) fail('Stripe is not configured', 503);
  if (invoice.status === 'Cancelled') fail('Cancelled invoices cannot be paid');
  if (!currencies.includes(invoice.currency)) fail('Payment links currently support ' + currencies.join(', '));
  const b = await balance(db, invoice),
    amountMinor = amount == null ? b.outstandingMinor : minor(amount);
  if (!amountMinor || amountMinor > b.outstandingMinor) fail('Choose an amount within the outstanding balance');
  const base = (process.env.FRONTEND_URL || '').split(',')[0];
  if (!/^https:\/\//.test(base) && process.env.NODE_ENV === 'production') fail('Configure an HTTPS FRONTEND_URL', 503);
  const row = await db.paymentCheckout.create({
    data: {
      invoiceId: invoice.id,
      amountMinor,
      currency: invoice.currency,
      invoiceVersion: invoice.updatedAt,
      createdById: userId
    }
  });
  const session = await stripe('checkout/sessions', {
    mode: 'payment',
    'line_items[0][price_data][currency]': invoice.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(amountMinor),
    'line_items[0][price_data][product_data][name]': 'Invoice ' + invoice.number,
    'line_items[0][quantity]': '1',
    'metadata[checkoutId]': row.id,
    success_url: base + '/api/public/payment-result?status=success',
    cancel_url: base + '/payment-result?status=cancelled'
  }, row.id);
  return db.paymentCheckout.update({
    where: {
      id: row.id
    },
    data: {
      sessionId: session.id,
      url: session.url,
      status: 'Open'
    }
  });
}
function verifyStripe(raw, header, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  if (!secret) fail('Stripe webhook is not configured', 503);
  const parts = String(header || '').split(',').map(p => p.split('=')),
    timestamp = parts.find(p => p[0] === 't')?.[1];
  if (!timestamp || !Number.isFinite(Number(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) fail('Invalid webhook timestamp', 400);
  const expected = crypto.createHmac('sha256', secret).update(timestamp + '.').update(raw).digest();
  if (!parts.some(([k, v]) => k === 'v1' && /^[a-f0-9]{64}$/i.test(v) && crypto.timingSafeEqual(expected, Buffer.from(v, 'hex')))) fail('Invalid webhook signature', 400);
  return JSON.parse(raw.toString());
}
async function reconcile(db, sessionId) {
  const row = await db.paymentCheckout.findUnique({
    where: {
      sessionId
    }
  });
  if (!row) fail('Checkout not found', 404);
  const session = await stripe('checkout/sessions/' + encodeURIComponent(sessionId));
  if (session.payment_status !== 'paid') return {
    status: session.payment_status
  };
  if (session.amount_total !== row.amountMinor || session.currency !== row.currency.toLowerCase() || session.metadata?.checkoutId !== row.id) fail('Checkout does not match the invoice payment', 409);
  await recordPayment(db, row.invoiceId, {
    provider: 'stripe',
    reference: session.id,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdById: row.createdById
  });
  return db.paymentCheckout.update({
    where: {
      id: row.id
    },
    data: {
      status: 'Paid'
    }
  });
}
module.exports = {
  minor,
  currencies,
  balance,
  recordPayment,
  checkout,
  verifyStripe,
  reconcile
};
