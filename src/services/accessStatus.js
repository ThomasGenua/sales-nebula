const crypto = require('crypto');
const { resolveJwtSecret } = require('../utils/secrets');
const key = crypto.createHmac('sha256', resolveJwtSecret()).update('sales-nebula:access-status:v1').digest();
const TTL = 7 * 24 * 3600;
const nonce = request => crypto.createHash('sha256').update(`${request.email}:${new Date(request.createdAt).toISOString()}`).digest('hex');
const sign = value => crypto.createHmac('sha256', key).update(value).digest('base64url');

function issue(request) {
  const payload = Buffer.from(JSON.stringify({ id: request.id, nonce: nonce(request), exp: Math.floor(Date.now() / 1000) + TTL })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

async function lookup(db, token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const actual = Buffer.from(parts[1]); const expected = Buffer.from(sign(parts[0]));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return null; }
  if (typeof payload.id !== 'string' || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return null;
  const request = await db.signupRequest.findUnique({ where: { id: payload.id } });
  return request && payload.nonce === nonce(request) ? request : null;
}

module.exports = { issue, lookup };
