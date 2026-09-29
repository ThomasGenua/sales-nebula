/**
 * A lease on a name, held in the database so that every process sees it.
 *
 * Several things here check "is there one already?" and then create one, and
 * two callers at the same moment both pass the check: two scheduler processes
 * both running a job (two sequence emails to one contact, two stale-deal
 * alerts), a double click on "Submit for approval" (two pending requests), a
 * second click on "Create invoice" (two invoices). Whoever holds the lease
 * goes on; the other is told it is taken and leaves.
 *
 * It is a row in AdminConfig, whose key is unique, so taking it is a single
 * insert that only one caller can win; nothing new in the schema. A holder that
 * dies leaves its row behind, so a lease carries an expiry and one that has
 * passed it can be taken over (by deleting exactly the row that was read, so
 * only one taker succeeds).
 *
 * Keys are `lease:<name>`. The admin config routes hide them.
 */
const crypto = require('crypto');

const PREFIX = 'lease:';

const keyFor = name => `${PREFIX}${name}`;

function expiryOf(row) {
  try { return Number(JSON.parse(row.value).expiresAt) || 0; } catch (err) { return 0; }
}

async function insert(prisma, key, value) {
  try {
    await prisma.adminConfig.create({ data: { key, value } });
    return true;
  } catch (err) {
    if (err.code === 'P2002') return false; // the key is unique: someone holds it
    throw err;
  }
}

/**
 * Take the lease for `ttlMs`. Returns a token to release it with, or null when
 * someone else holds it.
 */
async function acquireLease(prisma, name, ttlMs) {
  const key = keyFor(name);
  const token = crypto.randomUUID();
  const value = JSON.stringify({ token, expiresAt: Date.now() + ttlMs });

  if (await insert(prisma, key, value)) return token;

  // Held. It can be taken over only once it has expired.
  const current = await prisma.adminConfig.findUnique({ where: { key } });
  if (!current) return (await insert(prisma, key, value)) ? token : null; // released in between
  if (expiryOf(current) > Date.now()) return null;

  // Delete the row that was read, not whatever is there now: of several
  // callers finding the same expired lease, one deletes it and goes on.
  const { count } = await prisma.adminConfig.deleteMany({ where: { key, value: current.value } });
  if (count !== 1) return null;
  return (await insert(prisma, key, value)) ? token : null;
}

/** Give the lease back. Only its holder can: a lease that expired and was taken over is left alone. */
async function releaseLease(prisma, name, token) {
  const key = keyFor(name);
  const current = await prisma.adminConfig.findUnique({ where: { key } }).catch(() => null);
  if (!current) return;
  let holder = null;
  try { holder = JSON.parse(current.value).token; } catch (err) { /* unreadable: not ours */ }
  if (holder !== token) return;
  await prisma.adminConfig.deleteMany({ where: { key, value: current.value } }).catch(() => {});
}

/**
 * Run `fn` while holding the lease, and release it however `fn` ends.
 * `{ acquired: false }` when someone else holds it; otherwise `{ acquired: true, value }`.
 */
async function withLease(prisma, name, ttlMs, fn) {
  const token = await acquireLease(prisma, name, ttlMs);
  if (!token) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await releaseLease(prisma, name, token);
  }
}

module.exports = { acquireLease, releaseLease, withLease, LEASE_PREFIX: PREFIX };
