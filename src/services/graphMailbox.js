const graph = require('./microsoftGraph');
const { encrypt, decrypt } = require('../utils/secretBox');
const { ingestMessages, recordPoll } = require('./inboundIngest');

/**
 * Microsoft Graph mailboxes as the CRM sees them: token lifecycle, a poll that
 * feeds the shared ingestion pipeline, and replies sent from the mailbox that
 * received the message.
 */

/** Renew a minute early so a token cannot expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

function credentials(account) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.');
    err.status = 503;
    throw err;
  }
  return {
    clientId,
    clientSecret,
    tenantId: account.tenantId || process.env.MICROSOFT_TENANT_ID || 'common',
  };
}

/**
 * A usable access token for this mailbox, refreshing and persisting when the
 * cached one is spent. Microsoft may rotate the refresh token, so whatever
 * comes back is stored.
 */
async function getAccessToken(prisma, account, { force = false } = {}) {
  const cached = decrypt(account.oauthAccessToken);
  const expires = account.oauthExpiresAt ? new Date(account.oauthExpiresAt).getTime() : 0;
  if (!force && cached && expires - EXPIRY_SKEW_MS > Date.now()) return cached;

  const refreshToken = decrypt(account.oauthRefreshToken);
  if (!refreshToken) {
    const err = new Error('Mailbox is not connected. Complete the Microsoft consent flow first.');
    err.status = 409;
    throw err;
  }

  const tokens = await graph.refreshAccessToken({ ...credentials(account), refreshToken });
  await prisma.inboundEmailAccount.update({
    where: { id: account.id },
    data: {
      oauthAccessToken: encrypt(tokens.accessToken),
      oauthExpiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { oauthRefreshToken: encrypt(tokens.refreshToken) } : {}),
      lastError: null,
    },
  });
  return tokens.accessToken;
}

/** Run `fn` with a token, refreshing once if Graph rejects the cached one. */
async function withToken(prisma, account, fn) {
  let token = await getAccessToken(prisma, account);
  try {
    return await fn(token);
  } catch (err) {
    if (!err?.isAuthError) throw err;
    token = await getAccessToken(prisma, account, { force: true });
    return fn(token);
  }
}

/** Store the tokens from a completed consent redirect. */
async function connect(prisma, account, { code, redirectUri }) {
  const tokens = await graph.exchangeCode({ ...credentials(account), code, redirectUri });
  const profile = await graph.getProfile({
    accessToken: tokens.accessToken,
    mailboxAddress: account.mailboxAddress,
  }).catch(() => null);

  return prisma.inboundEmailAccount.update({
    where: { id: account.id },
    data: {
      provider: 'microsoft',
      oauthAccessToken: encrypt(tokens.accessToken),
      oauthRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : account.oauthRefreshToken,
      oauthExpiresAt: tokens.expiresAt,
      mailboxAddress: account.mailboxAddress || profile?.mail || profile?.userPrincipalName || null,
      status: 'Idle',
      lastError: null,
    },
  });
}

/** A live call, so a connection test means something. */
async function testConnection(prisma, account) {
  const profile = await withToken(prisma, account, accessToken =>
    graph.getProfile({ accessToken, mailboxAddress: account.mailboxAddress })
  );
  return {
    connected: true,
    mailbox: profile?.mail || profile?.userPrincipalName || account.mailboxAddress || null,
    displayName: profile?.displayName || null,
  };
}

/**
 * Fetch anything newer than the last sync and hand it to the shared pipeline.
 * Throttling is surfaced rather than swallowed so the scheduler can back off.
 */
async function pollAccount(prisma, account) {
  const startedAt = Date.now();
  await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { status: 'Polling' } });

  try {
    const raw = await withToken(prisma, account, accessToken =>
      graph.listMessages({
        accessToken,
        mailboxAddress: account.mailboxAddress,
        folder: account.mailbox && account.mailbox !== 'INBOX' ? account.mailbox : 'Inbox',
        since: account.lastSyncAt,
        top: account.maxMessagesPerPoll || 50,
      })
    );

    const messages = raw.map(graph.normalizeMessage);
    const stats = await ingestMessages(prisma, account, messages);

    await recordPoll(prisma, account, stats, messages);
    return { accountId: account.id, durationMs: Date.now() - startedAt, ...stats };
  } catch (err) {
    await prisma.inboundEmailAccount.update({
      where: { id: account.id },
      data: {
        status: 'Error',
        lastPolledAt: new Date(),
        lastError: String(err.message).slice(0, 400),
      },
    }).catch(() => {});
    throw err;
  }
}

/**
 * Reply on the original thread. Graph sets the threading headers and sends
 * from the receiving mailbox, so the correspondent sees a normal reply.
 */
async function reply(prisma, account, message, comment) {
  if (!message.externalId) {
    const err = new Error('This message has no Graph id, so it cannot be replied to in thread.');
    err.status = 409;
    throw err;
  }
  await withToken(prisma, account, accessToken =>
    graph.replyToMessage({
      accessToken,
      mailboxAddress: account.mailboxAddress,
      graphMessageId: message.externalId,
      comment,
    })
  );
  return prisma.inboundEmailMessage.update({
    where: { id: message.id },
    data: { status: 'Replied', repliedAt: new Date() },
  }).catch(() => null);
}

module.exports = { getAccessToken, withToken, connect, testConnection, pollAccount, reply };
