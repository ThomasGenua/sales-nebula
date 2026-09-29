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
 * In production a missing secret is fatal, and so is one that is a published
 * placeholder or too short to be a key: .env.example and docker-compose.yml
 * both carried "change-this-to-a-strong-random-secret-in-production", which
 * passed the "is it set" check, so a stack started from either signed
 * sessions with a value anyone can read here and forge an administrator's.
 * Outside production, a development constant keeps `npm run dev` working
 * without ceremony, and says so once.
 */

const DEV_FALLBACK = 'sales-nebula-development-secret-do-not-use-in-production';

// HS256 wants a key as long as its 256-bit output.
const MIN_SECRET_LENGTH = 32;

// The values this repository has shipped, and the usual stand-ins.
const PLACEHOLDERS = new Set([
  DEV_FALLBACK,
  'change-this-to-a-strong-random-secret-in-production',
  'change-this-secret',
  'sales-nebula-mail-key',
]);
const PLACEHOLDER_PATTERN = /change[-_ ]?(this|me)|do-not-use/i;

/** Why a secret must not sign sessions in production, or null when it may. */
function weakSecretReason(secret) {
  const value = String(secret).trim();
  if (PLACEHOLDERS.has(value.toLowerCase()) || PLACEHOLDER_PATTERN.test(value)) {
    return 'is a placeholder that is published in this repository';
  }
  if (value.length < MIN_SECRET_LENGTH) return `is shorter than ${MIN_SECRET_LENGTH} characters`;
  return null;
}

/** Refuse to go on: throw for a caller that asked to handle it, otherwise exit. */
function refuse(message, exit) {
  if (!exit) throw new Error(message);
  console.error(message);
  process.exit(1);
}

let warned = false;

function resolveJwtSecret({ exit = true } = {}) {
  const configured = process.env.JWT_SECRET;
  if (configured) {
    const weak = process.env.NODE_ENV === 'production' ? weakSecretReason(configured) : null;
    if (weak) {
      refuse(`FATAL: JWT_SECRET ${weak}. Refusing to start in production with a guessable signing key. `
        + 'Generate one with: openssl rand -base64 48', exit);
    }
    return configured;
  }

  if (process.env.NODE_ENV === 'production') {
    refuse('FATAL: JWT_SECRET is not set. Refusing to start in production with a known signing key.', exit);
  }

  if (!warned && process.env.NODE_ENV !== 'test') {
    warned = true;
    console.warn('JWT_SECRET is not set — using the development fallback. Never do this in production.');
  }
  return DEV_FALLBACK;
}

/** The secret that encrypts mail credentials at rest. */
function resolveMailSecret(options) {
  const { exit = true } = options || {};
  const configured = process.env.MAIL_SECRET;
  if (configured) {
    const weak = process.env.NODE_ENV === 'production' ? weakSecretReason(configured) : null;
    if (weak) refuse(`FATAL: MAIL_SECRET ${weak}. Generate one with: openssl rand -base64 48`, exit);
    return configured;
  }
  return resolveJwtSecret(options);
}

module.exports = { resolveJwtSecret, resolveMailSecret, weakSecretReason, DEV_FALLBACK, MIN_SECRET_LENGTH };
