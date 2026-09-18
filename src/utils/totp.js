const crypto = require('crypto');

/**
 * RFC 4648 base32 and RFC 6238 TOTP.
 *
 * Implemented here rather than pulled in as a dependency: it is ~60 lines and
 * the alternative was the previous placeholder, which accepted any six digits.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Constant-time compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hotp(secretBuf, counter, digits = 6) {
  const block = Buffer.alloc(8);
  block.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  block.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', secretBuf).update(block).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** A fresh base32 secret for enrolment. */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * Verify a TOTP code. `window` steps either side are accepted so a code is
 * still good across a clock skew of one period.
 */
function verifyTotp(secret, token, { window = 1, step = 30, digits = 6, now = Date.now() } = {}) {
  if (!new RegExp(`^\\d{${digits}}$`).test(String(token || ''))) return false;

  let secretBuf;
  try {
    secretBuf = base32Decode(secret);
  } catch {
    return false;
  }
  if (!secretBuf.length) return false;

  const counter = Math.floor(now / 1000 / step);
  for (let drift = -window; drift <= window; drift++) {
    if (safeEqual(hotp(secretBuf, counter + drift, digits), String(token))) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans. */
function otpAuthUrl({ secret, label, issuer = 'Sales Nebula' }) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { base32Encode, base32Decode, generateSecret, verifyTotp, hotp, otpAuthUrl, safeEqual };
