const jwt = require('jsonwebtoken');
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), {
    status
  });
};
function configured() {
  return ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_USER_ID', 'DOCUSIGN_PRIVATE_KEY', 'DOCUSIGN_ACCOUNT_ID'].every(k => process.env[k]);
}
async function connection() {
  if (!configured()) fail('Configure DocuSign JWT credentials and grant impersonation consent', 503);
  const host = process.env.DOCUSIGN_DEMO === 'true' ? 'account-d.docusign.com' : 'account.docusign.com';
  const assertion = jwt.sign({
    iss: process.env.DOCUSIGN_INTEGRATION_KEY,
    sub: process.env.DOCUSIGN_USER_ID,
    aud: host,
    scope: 'signature impersonation'
  }, process.env.DOCUSIGN_PRIVATE_KEY.replace(/\\n/g, '\n'), {
    algorithm: 'RS256',
    expiresIn: 3600
  });
  const response = await fetch('https://' + host + '/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) fail('DocuSign authorization failed; check credentials and consent', 502);
  const token = await response.json();
  const profile = await fetch('https://' + host + '/oauth/userinfo', {
    headers: {
      Authorization: 'Bearer ' + token.access_token
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!profile.ok) fail('Cannot load DocuSign account', 502);
  const account = (await profile.json()).accounts?.find(a => a.account_id === process.env.DOCUSIGN_ACCOUNT_ID);
  if (!account) fail('Configured DocuSign account is unavailable', 502);
  const base = new URL(account.base_uri);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.docusign.net')) fail('Invalid DocuSign API address', 502);
  return {
    base: base.origin + '/restapi/v2.1/accounts/' + encodeURIComponent(account.account_id),
    token: token.access_token
  };
}
async function request(path, body) {
  const c = await connection(),
    r = await fetch(c.base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'Content-Type': 'application/json'
      },
      ...(body && {
        body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(25000)
    });
  if (!r.ok) fail('DocuSign request failed (' + r.status + ')', 502);
  return r.json();
}
async function send(db, room, quote, name, email) {
  if (!configured()) fail('DocuSign is not configured', 503);
  if (typeof name !== 'string' || !name.trim() || name.length > 150 || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Provide the signer name and email');
  const existing = await db.signatureRequest.findFirst({
    where: {
      roomId: room.id,
      quoteId: quote.id,
      status: {
        in: ['Pending', 'sent', 'delivered', 'completed']
      }
    }
  });
  if (existing) fail('An envelope already exists for this room and quote; reconcile it first', 409);
  const row = await db.signatureRequest.create({
    data: {
      requestKey: room.id + ':' + quote.id + ':' + quote.updatedAt.toISOString(),
      roomId: room.id,
      quoteId: quote.id,
      quoteVersion: quote.updatedAt,
      signerName: name,
      signerEmail: email
    }
  });
  try {
    const currency = (await require('../utils/currency').currencyContext(db)).base;
    const data = require('./customerQuotes').snapshot(quote, currency);
    data.terms += '\n\nSignature: /sn_sign_here/';
    const pdf = await require('./customerQuotes').pdf(data);
    const result = await request('/envelopes', {
      transactionId: row.id,
      ...(process.env.DOCUSIGN_CONNECT_HMAC_KEY && { eventNotification: {
        url: require('../utils/mail').appUrl('/api/public/docusign/webhook'),
        requireAcknowledgment: 'true', includeHMAC: 'true', loggingEnabled: 'true',
        eventData: { version: 'restv2.1', format: 'json', includeData: ['envelope'] },
        envelopeEvents: ['sent', 'delivered', 'completed', 'declined', 'voided'].map(envelopeEventStatusCode => ({ envelopeEventStatusCode })),
      } }),
      emailSubject: 'Please sign quote ' + quote.number,
      documents: [{
        documentBase64: pdf.toString('base64'),
        name: 'Quote ' + quote.number,
        fileExtension: 'pdf',
        documentId: '1'
      }],
      recipients: {
        signers: [{
          email,
          name,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [{
              anchorString: '/sn_sign_here/',
              anchorUnits: 'pixels',
              anchorXOffset: '0',
              anchorYOffset: '0',
              anchorIgnoreIfNotPresent: 'false'
            }]
          }
        }]
      },
      status: 'sent'
    });
    return db.signatureRequest.update({
      where: {
        id: row.id
      },
      data: {
        envelopeId: result.envelopeId,
        status: result.status || 'sent'
      }
    });
  } catch (e) {
    await db.signatureRequest.update({
      where: {
        id: row.id
      },
      data: {
        error: String(e.message).slice(0, 300)
      }
    });
    throw e;
  }
}
async function reconcile(db, row) {
  if (!row.envelopeId) fail('Envelope outcome is uncertain; recover its ID from DocuSign before sending again', 409);
  const result = await request('/envelopes/' + encodeURIComponent(row.envelopeId));
  await require('./signatureEvents').apply(db, row, result.status, new Date(result.statusChangedDateTime || result.completedDateTime || Date.now()), result.voidedReason || result.declinedReason);
  return db.signatureRequest.findUnique({ where: { id: row.id } });
}
async function recover(db, row, envelopeId) {
  if (row.envelopeId) fail('An envelope is already linked; reconcile its status instead', 409);
  if (typeof envelopeId !== 'string' || !/^[a-f0-9-]{36}$/i.test(envelopeId)) fail('Enter a valid DocuSign envelope ID');
  const envelope = await request('/envelopes/' + encodeURIComponent(envelopeId));
  if (envelope.transactionId !== row.id) fail('That envelope does not belong to this signature request', 409);
  const claimed = await db.signatureRequest.updateMany({ where: { id: row.id, envelopeId: null }, data: { envelopeId } });
  if (!claimed.count) fail('This signature request changed; reload it', 409);
  return reconcile(db, { ...row, envelopeId });
}
module.exports = {
  configured,
  send,
  reconcile,
  recover,
  connection
};
