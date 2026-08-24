const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { validate, schemas } = require('../middleware/validate');
const { limiters } = require('../middleware/rateLimit');
const {
  authenticate, signAccessToken, signRefreshToken, signToken,
  blacklistToken, validatePassword,
  recordFailedLogin, clearLoginAttempts, isAccountLocked, getLockedUntil, getRemainingAttempts,
  JWT_SECRET,
} = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const jwt = require('jsonwebtoken');

const router = Router();

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

    // Issue access + refresh tokens
    const accessToken = signAccessToken(user.id, user.role.name);
    const { token: refreshToken, jti: refreshJti } = signRefreshToken(user.id);

    await audit(prisma, {
      action: 'login', module: 'auth',
      details: `${user.firstName} ${user.lastName} logged in`,
      userId: user.id,
    });

    const { password: _, ...safeUser } = user;
    res.json({
      token: accessToken,         // Backward compatible
      accessToken,
      refreshToken,
      expiresIn: 900,             // 15 minutes in seconds
      user: safeUser,
    });
  } catch (err) { next(err); }
});

// POST /api/auth/refresh - Exchange refresh token for new access token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
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
    res.json({ accessToken, token: accessToken, expiresIn: 900 });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired, please login again' });
    }
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /api/auth/logout - Revoke current access token
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    if (req.tokenJti) {
      await blacklistToken(req.tokenJti, 900); // Blacklist for 15min (access token lifetime)
    }

    const prisma = req.app.locals.prisma;
    await audit(prisma, { action: 'logout', module: 'auth', details: 'User logged out', userId: req.userId });

    res.json({ success: true });
  } catch (err) { next(err); }
});

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
    const { firstName, lastName, email, avatar } = req.body || {};
    const data = {};
    if (typeof firstName === 'string' && firstName.trim()) data.firstName = firstName.trim();
    if (typeof lastName === 'string' && lastName.trim()) data.lastName = lastName.trim();
    if (typeof email === 'string' && email.trim()) data.email = email.trim().toLowerCase();
    if (avatar !== undefined) data.avatar = avatar || null;

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

    let role = roleId;
    if (!role) {
      const defaultRole = await prisma.role.findFirst({ where: { name: 'Sales Rep' } });
      role = defaultRole?.id;
    }

    const hash = await bcrypt.hash(password, 12); // Cost 12 for production
    const user = await prisma.user.create({
      data: { email: email.toLowerCase(), password: hash, firstName, lastName, roleId: role },
      include: { role: { include: { permissions: true } } },
    });

    const token = signAccessToken(user.id, user.role.name);
    const { password: _, ...safeUser } = user;
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

module.exports = router;
