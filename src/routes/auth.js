const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { validate, schemas } = require('../middleware/validate');
const { limiters } = require('../middleware/rateLimit');
const {
  authenticate, signAccessToken, signRefreshToken, signToken,
  blacklistToken, isBlacklisted, validatePassword,
  recordFailedLogin, clearLoginAttempts, isAccountLocked, getLockedUntil, getRemainingAttempts,
  JWT_SECRET,
} = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { verifyTotp, safeEqual } = require('../utils/totp');
const jwt = require('jsonwebtoken');
const {
  ACCESS_COOKIE, REFRESH_COOKIE, readCookie, wantsCookieSession,
  setSessionCookies, clearSessionCookies, csrfValid,
} = require('../utils/sessionCookies');

const router = Router();

// The role a self-registered account is given when none is named.
const DEFAULT_SIGNUP_ROLE = process.env.DEFAULT_SIGNUP_ROLE || 'Sales Rep';

/**
 * Issue the session for a fully authenticated user. Shared by password login
 * and the MFA second step so both return an identical shape. A browser that
 * asks for a cookie session gets its tokens only as httpOnly cookies; every
 * other caller gets them in the body, as before.
 */
async function issueSession(prisma, user, req, res) {
  const accessToken = signAccessToken(user.id, user.role.name);
  const { token: refreshToken } = signRefreshToken(user.id);

  // The profile page shows this; nothing used to write it.
  const lastLoginAt = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt } });

  await audit(prisma, {
    action: 'login', module: 'auth',
    details: `${user.firstName} ${user.lastName} logged in`,
    userId: user.id,
  });

  const { password: _pw, ...rest } = user;
  const safeUser = { ...rest, lastLoginAt };
  if (wantsCookieSession(req)) {
    setSessionCookies(res, { accessToken, refreshToken });
    return res.json({ session: 'cookie', expiresIn: 900, user: safeUser });
  }
  return res.json({
    token: accessToken,         // Backward compatible
    accessToken,
    refreshToken,
    expiresIn: 900,             // 15 minutes in seconds
    user: safeUser,
  });
}

// POST /api/auth/login
router.post('/login', limiters.auth, validate(schemas.login), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Account lockout check
    if (isAccountLocked(email)) {
      const lockedUntil = getLockedUntil(email);
      return res.status(423).json({
        error: 'Account temporarily locked due to too many failed attempts',
        lockedUntil: lockedUntil.toISOString(),
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { role: { include: { permissions: true } } },
    });

    if (!user) {
      recordFailedLogin(email);
      const remaining = getRemainingAttempts(email);
      return res.status(401).json({ error: 'Invalid credentials', remainingAttempts: remaining });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Account disabled. Contact your administrator.' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      recordFailedLogin(email);
      const remaining = getRemainingAttempts(email);
      return res.status(401).json({ error: 'Invalid credentials', remainingAttempts: remaining });
    }

    // Successful login: clear attempts
    clearLoginAttempts(email);

    // A user with a verified device does not get a session from the password
    // alone. Without this gate, enrolling MFA protects nothing: this route
    // still hands out a token and every MFA endpoint lives elsewhere.
    const devices = await prisma.mfaDevice.findMany({
      where: { userId: user.id, verified: true },
      select: { id: true, type: true },
    });
    if (devices.length) {
      const mfaToken = jwt.sign(
        { sub: user.id, purpose: 'mfa-pending' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ mfaRequired: true, mfaToken, devices, expiresIn: 300 });
    }

    return issueSession(prisma, user, req, res);
  } catch (err) { next(err); }
});

// POST /api/auth/refresh - Exchange refresh token for new access token
router.post('/refresh', async (req, res, next) => {
  try {
    // A script sends its refresh token in the body. The browser's sits in an
    // httpOnly cookie that only /api/auth receives, and a request spending it
    // must prove it came from the page.
    const fromCookie = !req.body?.refreshToken;
    const refreshToken = req.body?.refreshToken || readCookie(req, REFRESH_COOKIE);
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    if (fromCookie && !csrfValid(req)) return res.status(403).json({ error: 'CSRF token missing or invalid', code: 'CSRF_FAILED' });

    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    // Signing out revokes the refresh token too; it used to stay good for a week.
    if (decoded.jti && await isBlacklisted(decoded.jti)) {
      return res.status(401).json({ error: 'Refresh token has been revoked' });
    }

    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { role: true },
    });
    if (!user || !user.active) {
      return res.status(401).json({ error: 'User not found or disabled' });
    }

    const accessToken = signAccessToken(user.id, user.role.name);
    if (fromCookie) {
      setSessionCookies(res, { accessToken });
      return res.json({ session: 'cookie', expiresIn: 900 });
    }
    res.json({ accessToken, token: accessToken, expiresIn: 900 });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired, please login again' });
    }
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /api/auth/logout - Revoke the session's tokens
// Works with an expired access token too, so a signed-out browser is never
// left holding cookies. Everything it can verify is revoked: the access token
// and, now, the refresh token, which used to stay good for a week.
router.post('/logout', async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    const bearer = header && header.startsWith('Bearer ') ? header.slice(7) : null;
    const hasSessionCookie = Boolean(readCookie(req, ACCESS_COOKIE) || readCookie(req, REFRESH_COOKIE));
    if (!bearer && !hasSessionCookie) return res.status(401).json({ error: 'No token provided' });
    // Only the page can sign its own session out; a forged cross-site request
    // cannot echo the CSRF token.
    if (!bearer && !csrfValid(req)) {
      return res.status(403).json({ error: 'CSRF token missing or invalid', code: 'CSRF_FAILED' });
    }

    const verified = (token, type) => {
      try { const d = jwt.verify(token, JWT_SECRET); return d.type === type ? d : null; } catch { return null; }
    };
    const access = verified(bearer || readCookie(req, ACCESS_COOKIE), 'access');
    const refresh = verified(req.body?.refreshToken || readCookie(req, REFRESH_COOKIE), 'refresh');
    const now = Math.floor(Date.now() / 1000);
    if (access?.jti) await blacklistToken(access.jti, Math.max(1, access.exp - now));
    if (refresh?.jti) await blacklistToken(refresh.jti, Math.max(1, refresh.exp - now));

    clearSessionCookies(res);
    const userId = access?.userId || refresh?.userId;
    if (userId) {
      const prisma = req.app.locals.prisma;
      await audit(prisma, { action: 'logout', module: 'auth', details: 'User logged out', userId });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

/** An IANA time zone this runtime knows, such as Europe/Paris. */
function isTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** The canonical BCP 47 form of a locale (en-gb -> en-GB), or null. */
function canonicalLocale(locale) {
  if (typeof locale !== 'string' || locale.length > 35) return null;
  try { return Intl.getCanonicalLocales(locale)[0] || null; } catch { return null; }
}

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { role: { include: { permissions: true } } },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) { next(err); }
});

// PUT /api/auth/me — update own profile (no users:full required)
router.put('/me', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { firstName, lastName, email, avatar, timezone, locale } = req.body || {};
    const data = {};
    if (typeof firstName === 'string' && firstName.trim()) data.firstName = firstName.trim();
    if (typeof lastName === 'string' && lastName.trim()) data.lastName = lastName.trim();
    if (typeof email === 'string' && email.trim()) data.email = email.trim().toLowerCase();
    if (avatar !== undefined) data.avatar = avatar || null;

    // Display preferences. An empty value goes back to the browser's own.
    if (timezone !== undefined) {
      if (timezone && !isTimeZone(timezone)) return res.status(400).json({ error: `Unknown time zone: ${timezone}` });
      data.timezone = timezone || null;
    }
    if (locale !== undefined) {
      const canonical = locale ? canonicalLocale(locale) : null;
      if (locale && !canonical) return res.status(400).json({ error: `Unknown locale: ${locale}` });
      data.locale = canonical;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No profile fields to update' });
    }

    if (data.email) {
      const clash = await prisma.user.findFirst({
        where: { email: data.email, NOT: { id: req.userId } },
      });
      if (clash) return res.status(409).json({ error: 'Email already in use' });
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data,
      include: { role: { include: { permissions: true } } },
    });
    await audit(prisma, { action: 'update', module: 'auth', details: 'Updated own profile', userId: req.userId });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) { next(err); }
});

// POST /api/auth/register
router.post('/register', limiters.auth, validate(schemas.register), async (req, res, next) => {
  try {
    // This schema has no tenancy: every record lives in one shared dataset,
    // so an open registration puts strangers inside live customer data.
    // Public signup goes through /api/signup, which issues an invite after
    // an administrator approves the request. Opening this route is an
    // explicit deployment decision, not the default.
    if (process.env.ALLOW_OPEN_REGISTRATION !== 'true') {
      return res.status(403).json({
        error: 'Self-registration is disabled. Request access at /api/signup, or ask an administrator for an invite.',
      });
    }

    const prisma = req.app.locals.prisma;
    const { email, password, firstName, lastName, roleId } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'All fields required' });
    }

    // Password complexity
    const pwCheck = validatePassword(password);
    if (!pwCheck.valid) {
      return res.status(400).json({ error: 'Password does not meet requirements', details: pwCheck.errors });
    }

    // Email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    // Fall back to the configured default role, and to nothing else. Picking
    // "any role that exists" would hand an Administrator role to a self
    // registrant on an installation that happens to have only that one.
    let role = roleId;
    if (!role) {
      const defaultRole = await prisma.role.findFirst({ where: { name: DEFAULT_SIGNUP_ROLE } });
      if (!defaultRole) {
        return res.status(503).json({
          error: `Self-registration is unavailable: no "${DEFAULT_SIGNUP_ROLE}" role is configured.`,
          code: 'NO_DEFAULT_ROLE',
        });
      }
      role = defaultRole.id;
    }

    const hash = await bcrypt.hash(password, 12); // Cost 12 for production
    const user = await prisma.user.create({
      data: { email: email.toLowerCase(), password: hash, firstName, lastName, roleId: role },
      include: { role: { include: { permissions: true } } },
    });

    const token = signAccessToken(user.id, user.role.name);
    const { password: _, ...safeUser } = user;
    if (wantsCookieSession(req)) {
      setSessionCookies(res, { accessToken: token, refreshToken: signRefreshToken(user.id).token });
      return res.status(201).json({ session: 'cookie', user: safeUser });
    }
    res.status(201).json({ token, user: safeUser });
  } catch (err) { next(err); }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }

    const pwCheck = validatePassword(newPassword);
    if (!pwCheck.valid) {
      return res.status(400).json({ error: 'New password does not meet requirements', details: pwCheck.errors });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    // Prevent reuse of same password
    const sameAsOld = await bcrypt.compare(newPassword, user.password);
    if (sameAsOld) return res.status(400).json({ error: 'New password must be different from current password' });

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.userId }, data: { password: hash } });

    await audit(prisma, { action: 'password_change', module: 'auth', details: 'Password changed', userId: req.userId });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/auth/forgot-password — always returns a generic response
router.post('/forgot-password', limiters.auth, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const generic = {
      accepted: true,
      message: 'If an account exists for that address, a reset link is on its way. Check your inbox and spam folder.',
    };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(202).json(generic);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.active !== false) {
      const { sendPasswordResetEmail, appUrl } = require('../utils/mail');
      const resetToken = jwt.sign(
        { sub: user.id, purpose: 'password-reset' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      const resetUrl = appUrl(`/reset-password?token=${encodeURIComponent(resetToken)}`);
      await sendPasswordResetEmail({
        to: user.email,
        firstName: user.firstName,
        resetUrl,
      });
      if (process.env.NODE_ENV !== 'production') {
        generic.devResetUrl = resetUrl;
      }
      await audit(prisma, {
        action: 'password_reset_request',
        module: 'auth',
        details: 'Password reset email issued',
        userId: user.id,
      }).catch(() => {});
    }

    res.status(202).json(generic);
  } catch (err) { next(err); }
});

// POST /api/auth/reset-password
router.post('/reset-password', limiters.auth, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token and newPassword are required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
    }
    if (decoded.purpose !== 'password-reset' || !decoded.sub) {
      return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
    }

    const pwCheck = validatePassword(newPassword);
    if (!pwCheck.valid) {
      return res.status(400).json({ error: 'New password does not meet requirements', details: pwCheck.errors });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user || user.active === false) {
      return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { password: hash } });
    await audit(prisma, {
      action: 'password_reset',
      module: 'auth',
      details: 'Password reset via email link',
      userId: user.id,
    });

    res.json({ success: true, message: 'Password updated. You can sign in with your new password.' });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/verify — second step of login, exchanges a code for a session
router.post('/mfa/verify', limiters.auth, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { mfaToken, deviceId, code } = req.body || {};
    if (!mfaToken || !code) {
      return res.status(400).json({ error: 'mfaToken and code are required' });
    }

    const expired = { error: 'That sign-in attempt expired. Start again.' };
    let decoded;
    try {
      decoded = jwt.verify(mfaToken, JWT_SECRET);
    } catch {
      return res.status(401).json(expired);
    }
    if (decoded.purpose !== 'mfa-pending' || !decoded.sub) {
      return res.status(401).json(expired);
    }

    const device = deviceId
      ? await prisma.mfaDevice.findFirst({ where: { id: deviceId, userId: decoded.sub, verified: true } })
      : await prisma.mfaDevice.findFirst({ where: { userId: decoded.sub, verified: true } });
    if (!device) return res.status(400).json({ error: 'No verified device for this account' });

    let ok = false;
    if (device.type === 'totp') {
      ok = verifyTotp(device.secret, code);
    } else {
      // SMS/email codes are issued as MfaChallenge rows and used once.
      const challenge = await prisma.mfaChallenge.findFirst({
        where: { userId: decoded.sub, deviceId: device.id, verified: false, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      ok = !!challenge && safeEqual(challenge.code, String(code));
      if (ok) {
        await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { verified: true } });
      }
    }

    if (!ok) {
      await audit(prisma, {
        action: 'mfa_failed', module: 'auth',
        details: 'Incorrect MFA code', userId: decoded.sub,
      }).catch(() => {});
      return res.status(401).json({ error: 'Incorrect code' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      include: { role: { include: { permissions: true } } },
    });
    if (!user || !user.active) return res.status(403).json({ error: 'Account disabled' });

    await prisma.mfaDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
    return issueSession(prisma, user, req, res);
  } catch (err) { next(err); }
});

module.exports = router;
