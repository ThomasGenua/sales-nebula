/**
 * The signing secret, resolved once and in one place.
 *
 * Four modules each fell back to their own hardcoded constant when JWT_SECRET
 * was unset — 'change-this-secret', 'changeme', 'sales-nebula-mail-key'. Two
 * consequences: in production the application would happily sign tokens with a
 * value published in this repository, so anyone could mint an administrator
 * session; and because the constants differed, a token issued by the connected
 * apps route did not validate against the one the auth middleware used.
 *
 * In production a missing secret is fatal. Outside it, a development constant
 * keeps `npm run dev` working without ceremony, and says so once.
 */

const DEV_FALLBACK = 'sales-nebula-development-secret-do-not-use-in-production';

let warned = false;

function resolveJwtSecret({ exit = true } = {}) {
  const configured = process.env.JWT_SECRET;
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    const message = 'FATAL: JWT_SECRET is not set. Refusing to start in production with a known signing key.';
    if (!exit) throw new Error(message);
    console.error(message);
    process.exit(1);
  }

  if (!warned && process.env.NODE_ENV !== 'test') {
    warned = true;
    console.warn('JWT_SECRET is not set — using the development fallback. Never do this in production.');
  }
  return DEV_FALLBACK;
}

/** The secret that encrypts mail credentials at rest. */
function resolveMailSecret(options) {
  return process.env.MAIL_SECRET || resolveJwtSecret(options);
}

module.exports = { resolveJwtSecret, resolveMailSecret, DEV_FALLBACK };
