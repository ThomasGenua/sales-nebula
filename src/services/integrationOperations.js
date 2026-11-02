const { permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { appUrl } = require('../utils/mail');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function setup() {
  const providers = [
    { id: 'smtp', name: 'Outgoing email', required: ['SMTP_HOST'], steps: ['Configure SMTP_HOST, SMTP_PORT and MAIL_FROM. Add SMTP_USER and SMTP_PASS when authentication is required.', 'Check the connection, then use a designated test recipient for a separate delivery test.'], check: true },
    { id: 'google', name: 'Google sign-in & mailbox', required: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], steps: ['Create a web OAuth client and allow your organization’s test users.', `Register sign-in redirect: ${appUrl('/oauth/callback')}`, `Register mailbox redirect: ${appUrl('/app/mailbox')}`, 'Enable OAUTH_LOGIN_ENABLED for existing-account sign-in. Each user connects their mailbox separately.'], check: false },
    { id: 'microsoft', name: 'Microsoft sign-in & Outlook', required: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID'], steps: ['Register a web application in your own Microsoft directory. Use the tenant GUID.', `Register sign-in redirect: ${appUrl('/oauth/callback')}`, `Register mailbox redirect: ${appUrl('/app/mailbox')}`, 'Grant delegated mailbox consent. Calendar synchronization also needs Calendars.ReadWrite. Enable OAUTH_LOGIN_ENABLED for browser sign-in.'], check: false },
    { id: 'stripe', name: 'Stripe payments', required: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], steps: ['Use test keys first. Keep the secret key in deployment configuration.', `Register checkout completion events at ${appUrl('/api/public/stripe/webhook')}`, 'Check API access, then reconcile any pending checkout before creating a new link.'], check: true },
    { id: 'docusign', name: 'DocuSign signatures', required: ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_USER_ID', 'DOCUSIGN_PRIVATE_KEY', 'DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_CONNECT_HMAC_KEY'], steps: ['Configure JWT impersonation credentials and grant consent. Use DOCUSIGN_DEMO=true for the demo account.', `Enable HMAC on Connect notifications to ${appUrl('/api/public/docusign/webhook')}. Use JSON SIM and envelope data.`, 'Subscribe to sent, delivered, completed, declined and voided. Scope notifications to this application’s envelopes.', 'Check API access. Signature status never automatically accepts a revised quote.'], check: true },
  ];
  return providers.map(p => {
    const missing = p.required.filter(key => !process.env[key]);
    const expiration = process.env[`${p.id.toUpperCase()}_CREDENTIAL_EXPIRES_AT`];
    const date = expiration && new Date(expiration);
    const warning = date && Number.isFinite(+date) && +date < Date.now() + 14 * 86400000 ? 'The configured credential expiry is within 14 days or has passed. Rotate credentials and check the connection.' : null;
    return { ...p, missing, configured: missing.length === 0, warning, credentialExpiresAt: date && Number.isFinite(+date) ? date.toISOString() : null };
  });
}
async function check(provider) {
  if (provider === 'smtp') {
    if (!process.env.SMTP_HOST) fail('Configure SMTP_HOST first', 503);
    const transport = require('nodemailer').createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, ...(process.env.SMTP_USER && { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } }) });
    try { await transport.verify(); } catch { fail('SMTP connection or authentication failed. Check deployment credentials and provider logs.', 502); } finally { transport.close(); }
  } else if (provider === 'stripe') {
    if (!process.env.STRIPE_SECRET_KEY) fail('Configure STRIPE_SECRET_KEY first', 503);
    const response = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail('Stripe connection failed. Check the key and its read permissions.', 502);
    await response.arrayBuffer();
  } else if (provider === 'docusign') await require('./signatures').connection();
  else fail('Choose SMTP, Stripe or DocuSign');
  return { connected: true, checkedAt: new Date().toISOString(), message: 'Connection verified. No message, payment or signature request was sent.' };
}
async function failures(db, req, diagnostics) {
  const items = [];
  const add = row => items.push(row);
  for (const m of diagnostics.mailboxes) {
    if (m.lastError || m.status === 'Error') add({ key: `mail:${m.id}`, kind: 'Mailbox', title: m.name, detail: m.lastError || 'Mailbox needs attention', at: m.lastPolledAt, module: 'mailbox', action: permits(req, 'emails', 'edit') ? { label: 'Retry mail sync', path: `/sales-mail/accounts/${m.id}/sync` } : null });
    if (m.calendarError) add({ key: `calendar:${m.id}`, kind: 'Calendar', title: m.name, detail: m.calendarError, at: m.calendarLastSyncedAt, module: 'mailbox', action: permits(req, 'activities', 'edit') && permits(req, 'emails', 'edit') ? { label: 'Retry calendar sync', path: `/outlook-calendar/${m.id}/sync` } : null });
  }
  for (const w of diagnostics.webhooks) for (const log of w.logs.filter(l => !l.success)) add({ key: `webhook:${log.id}`, kind: 'Webhook', title: w.name, detail: `${log.event}: HTTP ${log.statusCode || 'no response'}. Review delivery history; the receiver may already have processed it.`, at: log.createdAt, module: 'webhooks' });
  async function ids(module, model) {
    if (!permits(req, module, 'read')) return [];
    return (await db[model].findMany({ where: await reachableWhere(req, module, model), select: { id: true } })).map(row => row.id);
  }
  const invoiceIds = await ids('invoices', 'invoice');
  if (invoiceIds.length) for (const p of await db.paymentCheckout.findMany({ where: { invoiceId: { in: invoiceIds }, status: { in: ['Pending', 'Open'] } }, orderBy: { createdAt: 'desc' }, take: 50 })) add({ key: `payment:${p.id}`, kind: 'Payment', title: 'Pending checkout', detail: p.sessionId ? 'Check Stripe for the outcome before creating another checkout.' : 'No provider session was recorded. Review the invoice and Stripe before creating another checkout.', at: p.createdAt, module: 'invoices', recordId: p.invoiceId, action: p.sessionId && permits(req, 'invoices', 'edit') ? { label: 'Check payment status', path: `/payments/${p.invoiceId}/reconcile`, body: { sessionId: p.sessionId } } : null });
  const quoteIds = await ids('quotes', 'quote'), dealIds = await ids('deals', 'deal');
  const rooms = await db.dealRoom.findMany({ where: { dealId: { in: dealIds } }, select: { id: true, dealId: true } });
  if (rooms.length && quoteIds.length) for (const s of await db.signatureRequest.findMany({ where: { roomId: { in: rooms.map(r => r.id) }, quoteId: { in: quoteIds }, OR: [{ error: { not: null } }, { status: { in: ['Pending', 'declined', 'voided'] } }] }, orderBy: { createdAt: 'desc' }, take: 50 })) add({ key: `signature:${s.id}`, kind: 'Signature', title: `Signature ${s.status.toLowerCase()}`, detail: s.envelopeId ? 'Review the quote version and the envelope outcome.' : 'Outcome uncertain. Recover the matching envelope ID in Deal rooms before sending again.', at: s.statusChangedAt || s.createdAt, module: 'salesOperations', tab: 'dealRooms', action: s.envelopeId && permits(req, 'deals', 'edit') && permits(req, 'quotes', 'edit') ? { label: 'Check signature status', path: `/deal-rooms/${s.roomId}/signatures/${s.id}/reconcile` } : null });
  const campaignIds = await ids('campaigns', 'campaign');
  if (campaignIds.length) for (const c of await db.campaignDelivery.findMany({ where: { campaignId: { in: campaignIds }, createdById: req.userId, OR: [{ status: { in: ['Failed', 'Sending'] } }, { error: { not: null } }] }, orderBy: { createdAt: 'desc' }, take: 50 })) add({ key: `campaign:${c.id}`, kind: 'Campaign email', title: `Delivery ${c.status.toLowerCase()}`, detail: 'Review the delivery and provider logs. An uncertain SMTP outcome must not be resent automatically.', at: c.createdAt, module: 'salesOperations', tab: 'campaignDelivery' });
  return { items: items.sort((a, b) => +new Date(b.at || 0) - +new Date(a.at || 0)), limitPerKind: 50 };
}
module.exports = { setup, check, failures };
