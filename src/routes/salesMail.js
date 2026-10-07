const { Router } = require('express');
const crypto = require('crypto');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { linkRefusal, reachableWhere } = require('../middleware/access');
const { permits } = require('../middleware/auth');
const graphMailbox = require('../services/graphMailbox');
const { MAIL_SCOPES } = require('../services/microsoftGraph');
const { acquireLease, releaseLease } = require('../utils/lease');
const router = Router();
router.use(authenticate, requirePermission('emails', 'read'), auditMiddleware);
const hash = state => crypto.createHash('sha256').update(state).digest('hex');
const verifierFor = state => crypto.createHmac('sha256', process.env.MICROSOFT_CLIENT_SECRET).update(state).digest('base64url');
const accountWhere = req => ({ ownerId: req.userId, deletedAt: null });
const messageWhere = req => ({ deletedAt: null, account: { is: accountWhere(req) } });
const redirectUri = () => new URL('/app/mailbox', process.env.FRONTEND_URL || 'http://localhost:3000').href;
const safeAccount = a => ({ id: a.id, name: a.name, mailboxAddress: a.mailboxAddress, status: a.status, connected: !!a.oauthRefreshToken, lastPolledAt: a.lastPolledAt, lastError: a.lastError, active: a.active });

async function accountFor(req, res) {
  const account = await req.app.locals.prisma.inboundEmailAccount.findFirst({ where: { ...accountWhere(req), id: req.params.id } });
  if (!account) res.status(404).json({ error: 'Mailbox not found' });
  return account;
}

router.get('/accounts', async (req, res, next) => {
  try { res.json({ data: (await req.app.locals.prisma.inboundEmailAccount.findMany({ where: accountWhere(req), orderBy: { createdAt: 'asc' } })).map(safeAccount), configured: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET), redirectUri: redirectUri() }); } catch (e) { next(e); }
});
router.post('/accounts', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const account = await req.app.locals.prisma.inboundEmailAccount.create({ data: { name: String(req.body.name || 'My Outlook mailbox').slice(0, 120), username: req.user.email, provider: 'microsoft', ownerId: req.userId, autoCreateCase: false, autoCreateLead: false, autoReply: false, status: 'Disabled', active: false } });
    res.status(201).json(safeAccount(account));
  } catch (e) { next(e); }
});
router.post('/accounts/:id/authorize', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const account = await accountFor(req, res); if (!account) return;
    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) return res.status(503).json({ error: 'An administrator must configure MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET first.' });
    const state = crypto.randomBytes(32).toString('hex');
    await req.app.locals.prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { oauthStateHash: hash(state), oauthStateExpiresAt: new Date(Date.now() + 10 * 60000) } });
    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    const params = new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query', scope: MAIL_SCOPES, state, prompt: 'select_account', code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifierFor(state)).digest('base64url') });
    res.json({ url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params}` });
  } catch (e) { next(e); }
});
router.post('/connect', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const { state, code } = req.body;
    if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || typeof code !== 'string' || !code) return res.status(400).json({ error: 'Missing or invalid Microsoft consent response' });
    const db = req.app.locals.prisma;
    const account = await db.inboundEmailAccount.findFirst({ where: { ...accountWhere(req), oauthStateHash: hash(state), oauthStateExpiresAt: { gt: new Date() } } });
    if (!account) return res.status(400).json({ error: 'This connection request has expired or belongs to another user. Connect again.' });
    const claimed = await db.inboundEmailAccount.updateMany({ where: { id: account.id, oauthStateHash: hash(state) }, data: { oauthStateHash: null, oauthStateExpiresAt: null } });
    if (!claimed.count) return res.status(409).json({ error: 'This consent response has already been used.' });
    await graphMailbox.connect(db, account, { code, redirectUri: redirectUri(), codeVerifier: verifierFor(state) });
    const updated = await db.inboundEmailAccount.update({ where: { id: account.id }, data: { active: true } });
    await req.audit({ action: 'update', module: 'emails', recordId: account.id, details: 'Connected personal Outlook mailbox' });
    res.json(safeAccount(updated));
  } catch (e) { next(e); }
});
router.post('/accounts/:id/disconnect', requirePermission('emails', 'edit'), async (req, res, next) => {
  try { const a = await accountFor(req, res); if (!a) return;
    await req.app.locals.prisma.inboundEmailAccount.update({ where: { id: a.id }, data: { oauthAccessToken: null, oauthRefreshToken: null, oauthExpiresAt: null, oauthStateHash: null, oauthStateExpiresAt: null, status: 'Disabled', active: false } });
    res.json({ disconnected: true });
  } catch (e) { next(e); }
});
router.post('/accounts/:id/sync', requirePermission('emails', 'edit'), async (req, res, next) => {
  try { const a = await accountFor(req, res); if (!a) return; if (!a.active) return res.status(409).json({ error: 'Connect this mailbox before syncing.' }); res.json(await graphMailbox.pollAccount(req.app.locals.prisma, a)); } catch (e) { next(e); }
});

async function visibleAssociations(req, rows) {
  for (const [key, module, model] of [['contactId', 'contacts', 'contact'], ['dealId', 'deals', 'deal']]) {
    const ids = [...new Set(rows.map(r => r[key]).filter(Boolean))];
    const records = ids.length && permits(req, module, 'read') ? await req.app.locals.prisma[model].findMany({ where: await reachableWhere(req, module, model, { id: { in: ids } }), select: model === 'contact' ? { id: true, firstName: true, lastName: true } : { id: true, name: true } }) : [];
    const found = new Map(records.map(r => [r.id, r]));
    for (const row of rows) { row[model] = found.get(row[key]) || null; if (!found.has(row[key])) row[key] = null; }
  }
  return rows;
}
router.get('/messages', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma, page = Math.max(1, parseInt(req.query.page) || 1), where = messageWhere(req);
    for (const key of ['accountId', 'contactId', 'dealId']) if (req.query[key]) where[key] = String(req.query[key]);
    if (req.query.search) where.OR = ['subject', 'fromEmail'].map(key => ({ [key]: { contains: String(req.query.search), mode: 'insensitive' } }));
    if (req.query.unanswered === 'true') { where.direction = 'inbound'; where.repliedAt = null; where.status = { not: 'Ignored' }; }
    const [rows, total] = await Promise.all([db.inboundEmailMessage.findMany({ where, orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }], take: 25, skip: (page - 1) * 25 }), db.inboundEmailMessage.count({ where })]);
    res.json({ data: await visibleAssociations(req, rows), total, page });
  } catch (e) { next(e); }
});
router.get('/messages/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const message = await db.inboundEmailMessage.findFirst({ where: { ...messageWhere(req), id: req.params.id } });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    const where = { ...messageWhere(req), accountId: message.accountId, ...(message.threadKey ? { threadKey: message.threadKey } : { id: message.id }) };
    const [rows, total] = await Promise.all([db.inboundEmailMessage.findMany({ where, orderBy: { receivedAt: 'desc' }, take: 100 }), db.inboundEmailMessage.count({ where })]);
    res.json({ message: (await visibleAssociations(req, [message]))[0], thread: await visibleAssociations(req, rows.reverse()), total });
  } catch (e) { next(e); }
});
router.put('/messages/:id/links', requirePermission('emails', 'edit'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const message = await db.inboundEmailMessage.findFirst({ where: { ...messageWhere(req), id: req.params.id } });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    const data = { contactId: req.body.contactId || null, dealId: req.body.dealId || null };
    if (Object.values(data).some(v => v !== null && typeof v !== 'string')) return res.status(400).json({ error: 'Record links must be IDs' });
    const problem = await linkRefusal(req, 'inboundEmailMessage', data);
    if (problem) return res.status(400).json({ error: problem });
    await db.inboundEmailMessage.updateMany({ where: { ...messageWhere(req), accountId: message.accountId, ...(message.threadKey ? { threadKey: message.threadKey } : { id: message.id }) }, data });
    res.json({ linked: true });
  } catch (e) { next(e); }
});
router.post('/messages/:id/reply', requirePermission('emails', 'edit'), async (req, res, next) => {
  let lease;
  try {
    const db = req.app.locals.prisma, body = String(req.body.body || '').trim();
    if (!body || body.length > 50000) return res.status(400).json({ error: 'A reply of 1–50,000 characters is required' });
    const message = await db.inboundEmailMessage.findFirst({ where: { ...messageWhere(req), id: req.params.id, direction: 'inbound' }, include: { account: true } });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (!message.account.active) return res.status(409).json({ error: 'Reconnect this mailbox before replying.' });
    lease = await acquireLease(db, `sales-reply:${message.id}`, 60000);
    if (!lease) return res.status(409).json({ error: 'A reply is already being sent.' });
    if (message.replyBody === body && message.repliedAt && Date.now() - message.repliedAt < 60000) return res.json({ replied: true, duplicate: true });
    await graphMailbox.reply(db, message.account, message, body);
    await db.$transaction([
      db.inboundEmailMessage.updateMany({ where: { accountId: message.accountId, direction: 'inbound', receivedAt: { lte: message.receivedAt }, ...(message.threadKey ? { threadKey: message.threadKey } : { id: message.id }) }, data: { repliedAt: new Date(), status: 'Replied', replyBody: body } }),
      db.inboundEmailMessage.create({ data: { accountId: message.accountId, direction: 'outbound', threadKey: message.threadKey, fromEmail: message.account.mailboxAddress || req.user.email, toEmails: message.fromEmail, subject: `Re: ${(message.subject || '').replace(/^Re:\s*/i, '')}`, textBody: body, status: 'Sent', contactId: message.contactId, dealId: message.dealId } }),
    ]);
    await req.audit({ action: 'create', module: 'emails', recordId: message.id, details: 'Replied from personal Outlook mailbox' });
    res.json({ replied: true });
  } catch (e) { next(e); }
  finally { if (lease) await releaseLease(req.app.locals.prisma, `sales-reply:${req.params.id}`, lease); }
});
module.exports = router;
