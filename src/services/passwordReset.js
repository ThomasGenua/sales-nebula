const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { sendPasswordResetEmail, appUrl } = require('../utils/mail');

/**
 * A stamp of the password a reset link replaces. The link carries it, so it
 * stops working once the password changes: it used to work for its whole hour.
 */
const passwordStamp = hash => crypto.createHmac('sha256', JWT_SECRET).update(String(hash || '')).digest('base64url').slice(0, 22);

/**
 * Email `user` a link to choose a new password, good for an hour and once.
 * Used when someone asks for their own (/api/auth/forgot-password) and when an
 * administrator sends one (/api/users/:id/password-reset), so both links are
 * the same and /api/auth/reset-password honours either.
 */
async function issuePasswordReset(user, { byAdmin = false } = {}) {
  const token = jwt.sign(
    { sub: user.id, purpose: 'password-reset', pw: passwordStamp(user.password) },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
  const resetUrl = appUrl(`/reset-password?token=${encodeURIComponent(token)}`);
  const mail = await sendPasswordResetEmail({ to: user.email, firstName: user.firstName, resetUrl, byAdmin });
  return { resetUrl, mail };
}

module.exports = { passwordStamp, issuePasswordReset };
