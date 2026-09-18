/**
 * Microsoft Graph mail client.
 *
 * Written against the REST API with the global fetch, the same way
 * routes/oauth.js already talks to login.microsoftonline.com, rather than
 * pulling in the Graph SDK and MSAL for the handful of calls we make.
 *
 * Delegated tokens act on /me; application tokens act on /users/{upn}. An
 * account that names a mailboxAddress uses the second form, so one app
 * registration can service several shared mailboxes.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

class GraphError extends Error {
  constructor(message, { status, code, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    /** A 401 means the caller should refresh and retry once. */
    this.isAuthError = status === 401;
    /** A 429 or 503 is throttling: back off, do not treat as fatal. */
    this.isThrottled = status === 429 || status === 503;
  }
}

function tokenEndpoint(tenantId) {
  return `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;
}

/** The scopes a mailbox integration needs. offline_access buys the refresh token. */
const MAIL_SCOPES = 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send';

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new GraphError(body.error_description || body.error || 'Token request failed', {
      status: res.status,
      code: body.error,
    });
  }
  return {
    accessToken: body.access_token,
    // Microsoft may or may not rotate the refresh token; keep the old one when it does not.
    refreshToken: body.refresh_token || null,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000),
    scope: body.scope || null,
  };
}

/** Swap the authorization code from the consent redirect for tokens. */
function exchangeCode({ tenantId, clientId, clientSecret, code, redirectUri }) {
  return postForm(tokenEndpoint(tenantId), {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: MAIL_SCOPES,
  });
}

function refreshAccessToken({ tenantId, clientId, clientSecret, refreshToken }) {
  return postForm(tokenEndpoint(tenantId), {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: MAIL_SCOPES,
  });
}

async function graphFetch(path, { accessToken, method = 'GET', body } = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new GraphError(payload?.error?.message || `Graph request failed (${res.status})`, {
      status: res.status,
      code: payload?.error?.code,
      retryAfterSeconds: Number(res.headers?.get?.('retry-after')) || undefined,
    });
  }
  return res.json().catch(() => null);
}

/** "/me" for a delegated token, "/users/{upn}" for an application one. */
function mailboxRoot(mailboxAddress) {
  return mailboxAddress ? `/users/${encodeURIComponent(mailboxAddress)}` : '/me';
}

function getProfile({ accessToken, mailboxAddress }) {
  return graphFetch(`${mailboxRoot(mailboxAddress)}?$select=id,displayName,mail,userPrincipalName`, { accessToken });
}

const MESSAGE_FIELDS = [
  'id', 'internetMessageId', 'conversationId', 'subject', 'bodyPreview',
  'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'hasAttachments', 'body',
].join(',');

/**
 * Messages received after `since`, oldest first so a partial run still makes
 * forward progress. internetMessageHeaders carries In-Reply-To and References,
 * which the ingestion pipeline threads on.
 */
async function listMessages({ accessToken, mailboxAddress, folder = 'Inbox', since, top = 50 }) {
  const params = [
    `$select=${MESSAGE_FIELDS},internetMessageHeaders`,
    '$orderby=receivedDateTime asc',
    `$top=${Math.min(Number(top) || 50, 100)}`,
  ];
  if (since) {
    params.push(`$filter=receivedDateTime gt ${new Date(since).toISOString()}`);
  }
  const path = `${mailboxRoot(mailboxAddress)}/mailFolders/${encodeURIComponent(folder)}/messages?${params.join('&')}`;
  const page = await graphFetch(path, { accessToken });
  return page?.value || [];
}

function headerValue(message, name) {
  const headers = message.internetMessageHeaders || [];
  const hit = headers.find(h => String(h.name).toLowerCase() === name.toLowerCase());
  return hit?.value || null;
}

function addressOf(recipient) {
  const addr = recipient?.emailAddress;
  if (!addr) return null;
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

/**
 * Reshape a Graph message into what the ingestion pipeline already accepts,
 * so Graph and the IMAP worker feed the same code path.
 */
function normalizeMessage(message) {
  const html = message.body?.contentType === 'html' ? message.body?.content : null;
  const text = message.body?.contentType === 'text' ? message.body?.content : (message.bodyPreview || '');
  const references = headerValue(message, 'References');

  return {
    graphId: message.id,
    messageId: message.internetMessageId || null,
    inReplyTo: headerValue(message, 'In-Reply-To'),
    references: references ? references.split(/\s+/).filter(Boolean) : null,
    conversationId: message.conversationId || null,
    from: addressOf(message.from),
    to: (message.toRecipients || []).map(addressOf).filter(Boolean).join(', ') || null,
    cc: (message.ccRecipients || []).map(addressOf).filter(Boolean).join(', ') || null,
    subject: message.subject || '(no subject)',
    text,
    html,
    date: message.receivedDateTime || null,
    attachments: message.hasAttachments ? [{ placeholder: true }] : [],
  };
}

/**
 * Reply on the original thread. Graph sets In-Reply-To and References itself
 * and sends from the mailbox that received the message, which is what a
 * correspondent expects to see.
 */
function replyToMessage({ accessToken, mailboxAddress, graphMessageId, comment }) {
  return graphFetch(`${mailboxRoot(mailboxAddress)}/messages/${encodeURIComponent(graphMessageId)}/reply`, {
    accessToken,
    method: 'POST',
    body: { comment },
  });
}

/** A new message, for when there is no thread to reply to. */
function sendMail({ accessToken, mailboxAddress, to, subject, body, isHtml = false }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(address => ({ emailAddress: { address } }));
  return graphFetch(`${mailboxRoot(mailboxAddress)}/sendMail`, {
    accessToken,
    method: 'POST',
    body: {
      message: {
        subject,
        body: { contentType: isHtml ? 'HTML' : 'Text', content: body },
        toRecipients: recipients,
      },
      saveToSentItems: true,
    },
  });
}

module.exports = {
  GraphError,
  MAIL_SCOPES,
  exchangeCode,
  refreshAccessToken,
  getProfile,
  listMessages,
  normalizeMessage,
  replyToMessage,
  sendMail,
  mailboxRoot,
};
