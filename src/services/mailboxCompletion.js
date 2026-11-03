const crypto = require('crypto');
const { encrypt, decrypt } = require('../utils/secretBox');
const { acquireLease, releaseLease } = require('../utils/lease');
const { appUrl } = require('../utils/mail');
const graph = require('./microsoftGraph');
const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_RESPONSE = 28 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = value => crypto.createHash('sha256').update(String(value)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const google = () => require('./googleWorkspace');
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
function gmailParts(payload) {
  const files = [];
  const visit = (part, index) => {
    if (part.filename && (part.body?.attachmentId || typeof part.body?.data === 'string')) files.push({ id: part.body.attachmentId || 'inline:' + index, name: part.filename, size: part.body.size || 0, contentType: part.mimeType, ...(typeof part.body.data === 'string' && { data: part.body.data }) });
    (part.parts || []).forEach((child, i) => visit(child, index + '.' + i));
  };
  visit(payload || {}, '0'); return files;
}

async function ms(db, account, path, options = {}) {
  if (path.startsWith('https://graph.microsoft.com/v1.0/')) path = path.slice('https://graph.microsoft.com/v1.0'.length);
  if (!path.startsWith('/') || path.startsWith('//')) fail('Invalid Graph destination');
  return require('./graphMailbox').withToken(db, account, accessToken => graph.graphFetch(path, { accessToken, ...options }));
}
async function attachments(db, account, message) {
  if (!account.active || !account.oauthRefreshToken) fail('Reconnect this mailbox to download attachments', 409);
  if (!message.externalId) return [];
  if (account.provider === 'google') {
    const data = await google().request(db, account, `${gmail}/messages/${encodeURIComponent(message.externalId)}?format=full`, { maxResponseBytes: MAX_RESPONSE });
    return gmailParts(data.payload).map(({ data, ...f }) => ({ ...f, downloadable: f.size <= MAX_ATTACHMENT }));
  }
  const root = `${graph.mailboxRoot(account.mailboxAddress)}/messages/${encodeURIComponent(message.externalId)}/attachments`;
  const files = []; let next = root + '?$select=id,name,size,contentType,isInline&$top=100';
  for (let page = 0; next && page < 20; page++) {
    const data = await ms(db, account, next, { maxResponseBytes: 2 * 1024 * 1024 });
    files.push(...(data.value || []).filter(f => f['@odata.type'] === '#microsoft.graph.fileAttachment').map(f => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType, downloadable: f.size <= MAX_ATTACHMENT })));
    next = data['@odata.nextLink'];
  }
  if (next) fail('This message has too many attachments. Open it in your mailbox provider.', 413);
  return files;
}
async function download(db, account, message, id) {
  const file = (await attachments(db, account, message)).find(f => f.id === id);
  if (!file) fail('Attachment not found', 404);
  if (!file.downloadable) fail('Attachments larger than 20 MB must be downloaded from your mailbox provider', 413);
  let data = account.provider === 'google' && id.startsWith('inline:')
    ? await google().request(db, account, `${gmail}/messages/${encodeURIComponent(message.externalId)}?format=full`, { maxResponseBytes: MAX_RESPONSE })
    : account.provider === 'google'
    ? await google().request(db, account, `${gmail}/messages/${encodeURIComponent(message.externalId)}/attachments/${encodeURIComponent(id)}`, { maxResponseBytes: MAX_RESPONSE })
    : await ms(db, account, `${graph.mailboxRoot(account.mailboxAddress)}/messages/${encodeURIComponent(message.externalId)}/attachments/${encodeURIComponent(id)}`, { maxResponseBytes: MAX_RESPONSE });
  if (account.provider === 'google' && id.startsWith('inline:')) data = { data: gmailParts(data.payload).find(f => f.id === id)?.data };
  const encoded = account.provider === 'google' ? data.data : data.contentBytes;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_ATTACHMENT * 4 / 3) + 4) fail('Attachment exceeds the download limit', 413);
  const bytes = Buffer.from(encoded, account.provider === 'google' ? 'base64url' : 'base64');
  if (bytes.length > MAX_ATTACHMENT) fail('Attachment exceeds the download limit', 413);
  return { ...file, bytes };
}
function configured(provider) {
  return provider === 'google' ? !!(process.env.GOOGLE_PUBSUB_TOPIC && process.env.GOOGLE_PUBSUB_AUDIENCE && process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL) : /^https:\/\//.test(appUrl('/'));
}
async function enable(db, account) {
  if (!account.active || !account.ownerId || !account.oauthRefreshToken) fail('Connect a personal mailbox first', 409);
  if (!configured(account.provider)) fail(account.provider === 'google' ? 'Configure the Gmail Pub/Sub topic, audience and service account first' : 'Configure an HTTPS application URL first', 503);
  await db.mailboxSubscription.upsert({ where: { accountId: account.id }, create: { accountId: account.id, provider: account.provider, stateSecret: encrypt(crypto.randomBytes(32).toString('hex')), pendingAt: new Date() }, update: { enabled: true, retryAt: null } });
  return renew(db, account);
}
async function renew(db, account) {
  const key = `mail-push:${account.id}`, lease = await acquireLease(db, key, 120000);
  if (!lease) return { pending: true };
  try {
    const row = await db.mailboxSubscription.findUnique({ where: { accountId: account.id } });
    if (!row?.enabled) return { disabled: true };
    let expiresAt, remoteId = row.remoteId;
    if (account.provider === 'google') {
      const watched = await google().request(db, account, gmail + '/watch', { method: 'POST', body: { topicName: process.env.GOOGLE_PUBSUB_TOPIC } });
      expiresAt = new Date(Number(watched.expiration));
      // Keep the existing history cursor: watch's newest cursor must never skip mail.
    } else {
      let result;
      const expiry = new Date(Date.now() + 2 * 86400000).toISOString();
      if (remoteId) {
        try { result = await ms(db, account, '/subscriptions/' + encodeURIComponent(remoteId), { method: 'PATCH', body: { expirationDateTime: expiry } }); }
        catch (e) { if (![404, 410].includes(e.status)) throw e; remoteId = null; }
      }
      if (!remoteId) {
        const resource = graph.mailboxRoot(account.mailboxAddress).slice(1) + '/messages';
        const notificationUrl = appUrl('/api/public/mail-notifications/microsoft');
        const body = { changeType: 'created,updated,deleted', resource, notificationUrl, lifecycleNotificationUrl: notificationUrl, expirationDateTime: expiry, clientState: decrypt(row.stateSecret) };
        try { result = await ms(db, account, '/subscriptions', { method: 'POST', body }); }
        catch (e) {
          if (e.status !== 409) throw e;
          const existing = await ms(db, account, '/subscriptions');
          result = existing.value?.find(s => s.resource === resource && s.notificationUrl === notificationUrl && same(s.clientState, body.clientState));
          if (!result) throw e;
        }
      }
      remoteId = result.id || remoteId;
      expiresAt = new Date(result.expirationDateTime);
    }
    if (!Number.isFinite(+expiresAt) || +expiresAt <= Date.now()) fail('Provider returned an invalid subscription expiry', 502);
    await db.mailboxSubscription.update({ where: { accountId: account.id }, data: { remoteId, expiresAt, renewAt: new Date(Math.min(Date.now() + 86400000, +expiresAt - 3600000)), lastRenewedAt: new Date(), lastError: null, retryAt: null } });
    return { enabled: true, expiresAt };
  } finally { await releaseLease(db, key, lease); }
}
async function disable(db, account) {
  const row = await db.mailboxSubscription.findUnique({ where: { accountId: account.id } });
  if (!row) return { enabled: false };
  // Stop accepting notifications before attempting the remote cleanup.
  await db.mailboxSubscription.update({ where: { accountId: account.id }, data: { enabled: false, pendingAt: null } });
  try {
    if (account.provider === 'google') await google().request(db, account, gmail + '/stop', { method: 'POST' });
    else if (row.remoteId) await ms(db, account, '/subscriptions/' + encodeURIComponent(row.remoteId), { method: 'DELETE' });
    await db.mailboxSubscription.update({ where: { accountId: account.id }, data: { remoteId: null, expiresAt: null, lastError: null } });
  } catch { await db.mailboxSubscription.update({ where: { accountId: account.id }, data: { lastError: 'Updates stopped locally; the provider subscription will expire.' } }); }
  return { enabled: false };
}
async function microsoftNotification(db, values) {
  if (!Array.isArray(values) || values.length > 1000) fail('Invalid notification batch');
  for (const event of values) {
    if (typeof event.subscriptionId !== 'string' || typeof event.clientState !== 'string') continue;
    const row = await db.mailboxSubscription.findUnique({ where: { remoteId: event.subscriptionId } });
    if (!row?.enabled || row.provider !== 'microsoft' || !same(decrypt(row.stateSecret), event.clientState)) continue;
    const now = new Date();
    await db.mailboxSubscription.update({ where: { accountId: row.accountId }, data: { pendingAt: now, lastNotifiedAt: now, retryAt: null, ...(event.lifecycleEvent && { renewAt: now }), ...(event.lifecycleEvent === 'subscriptionRemoved' && { remoteId: null }) } });
  }
}
async function googleNotification(db, req) {
  if (!configured('google')) fail('Gmail push is not configured', 503);
  const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1];
  if (!token) fail('Missing Pub/Sub identity', 401);
  let claims;
  try { claims = (await new (require('google-auth-library').OAuth2Client)().verifyIdToken({ idToken: token, audience: process.env.GOOGLE_PUBSUB_AUDIENCE })).getPayload(); }
  catch { fail('Invalid Pub/Sub identity', 401); }
  if (claims.email !== process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL || claims.email_verified !== true) fail('Unexpected Pub/Sub identity', 403);
  let data;
  try { data = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString('utf8')); } catch { fail('Invalid Pub/Sub message'); }
  if (typeof data.emailAddress !== 'string') fail('Missing mailbox address');
  const accounts = await db.inboundEmailAccount.findMany({ where: { provider: 'google', active: true, deletedAt: null, mailboxAddress: { equals: data.emailAddress, mode: 'insensitive' } }, select: { id: true } });
  await db.mailboxSubscription.updateMany({ where: { accountId: { in: accounts.map(a => a.id) }, enabled: true }, data: { pendingAt: new Date(), lastNotifiedAt: new Date(), retryAt: null } });
}
async function processDue(db) {
  const now = new Date();
  const rows = await db.mailboxSubscription.findMany({ where: { enabled: true, AND: [{ OR: [{ retryAt: null }, { retryAt: { lte: now } }] }, { OR: [{ renewAt: null }, { renewAt: { lte: now } }, { pendingAt: { not: null } }] }] }, take: 50 });
  for (const row of rows) {
    const account = await db.inboundEmailAccount.findFirst({ where: { id: row.accountId, active: true, deletedAt: null } });
    try {
      if (!account?.ownerId) { await db.mailboxSubscription.update({ where: { accountId: row.accountId }, data: { enabled: false } }); continue; }
      await require('./revenueActor').asActor(db, account.ownerId, 'emails', async actorDb => {
        if (!row.renewAt || row.renewAt <= now) await renew(actorDb, account);
        if (row.pendingAt) {
          const result = await require('./graphMailbox').pollAccount(actorDb, account);
          if (!result.skipped && !result.moreMayBeAvailable && !result.more) await actorDb.mailboxSubscription.updateMany({ where: { accountId: account.id, pendingAt: row.pendingAt }, data: { pendingAt: null, lastError: null, retryAt: null } });
        }
      });
    } catch (e) {
      await db.mailboxSubscription.update({ where: { accountId: row.accountId }, data: { lastError: String(e.message).slice(0, 300), retryAt: new Date(Date.now() + 5 * 60000), ...(e.status === 403 && { enabled: false }) } });
    }
  }
}
module.exports = { attachments, download, enable, disable, renew, configured, microsoftNotification, googleNotification, processDue };
