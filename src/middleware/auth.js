/**
 * Authentication & Authorization Middleware (Production-Hardened)
 * 
 * Features:
 * - JWT access tokens (short-lived, 15min) + refresh tokens (7d)
 * - Token blacklist for revocation (Redis or in-memory)
 * - Account lockout after failed attempts
 * - Password complexity validation
 * - API key auth for service-to-service calls
 * - Role-based permission checks (4 tiers per module)
 */

const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const JWT_ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || '15m';
const JWT_REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES || '7d';
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
const LOCKOUT_DURATION_MS = parseInt(process.env.LOCKOUT_DURATION_MS) || 15 * 60 * 1000;

// ─── TOKEN BLACKLIST (for logout/revocation) ───
const tokenBlacklist = new Set();
let redisClient = null;

function setRedisClient(client) { redisClient = client; }

async function blacklistToken(jti, expiresInSec) {
  tokenBlacklist.add(jti);
  if (redisClient) {
    try { await redisClient.set(`bl:${jti}`, '1', 'EX', expiresInSec); } catch (e) { /* fallback to memory */ }
  }
  // Cleanup memory set periodically (prevent unbounded growth)
  if (tokenBlacklist.size > 10000) {
    const arr = [...tokenBlacklist];
    arr.slice(0, 5000).forEach(t => tokenBlacklist.delete(t));
  }
}

async function isBlacklisted(jti) {
  if (tokenBlacklist.has(jti)) return true;
  if (redisClient) {
    try { return !!(await redisClient.get(`bl:${jti}`)); } catch (e) { return false; }
  }
  return false;
}

// ─── ACCOUNT LOCKOUT ───
const loginAttempts = new Map(); // email -> { count, lockedUntil }

function recordFailedLogin(email) {
  const record = loginAttempts.get(email) || { count: 0, lockedUntil: null };
  record.count++;
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  loginAttempts.set(email, record);
}

function clearLoginAttempts(email) {
  loginAttempts.delete(email);
}

function isAccountLocked(email) {
  const record = loginAttempts.get(email);
  if (!record || !record.lockedUntil) return false;
  if (Date.now() > record.lockedUntil) {
    loginAttempts.delete(email);
    return false;
  }
  return true;
}

function getLockedUntil(email) {
  const record = loginAttempts.get(email);
  return record?.lockedUntil ? new Date(record.lockedUntil) : null;
}

function getRemainingAttempts(email) {
  const record = loginAttempts.get(email);
  if (!record) return MAX_LOGIN_ATTEMPTS;
  return Math.max(0, MAX_LOGIN_ATTEMPTS - record.count);
}

// ─── PASSWORD POLICY ───
function validatePassword(password) {
  const errors = [];
  if (!password || password.length < 8) errors.push('Password must be at least 8 characters');
  if (password.length > 128) errors.push('Password must be 128 characters or fewer');
  if (!/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('Password must contain at least one number');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Password must contain at least one special character');
  return { valid: errors.length === 0, errors };
}

// ─── TOKEN GENERATION ───
function signAccessToken(userId, role) {
  return jwt.sign({ userId, role, type: 'access', jti: uuid() }, JWT_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRES,
  });
}

function signRefreshToken(userId) {
  const jti = uuid();
  return {
    token: jwt.sign({ userId, type: 'refresh', jti }, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES }),
    jti,
  };
}

// Backward-compatible: returns access token (legacy callers expect signToken)
function signToken(userId, role) {
  return signAccessToken(userId, role);
}

// ─── API KEY AUTH ───
async function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next(); // Fall through to JWT auth

  try {
    const prisma = req.app.locals.prisma;
    const keyRecord = await prisma.apiKey.findUnique({ where: { key: apiKey } });
    if (!keyRecord) return res.status(401).json({ error: 'Invalid API key' });
    if (!keyRecord.active) return res.status(401).json({ error: 'API key disabled' });
    if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
      return res.status(401).json({ error: 'API key expired' });
    }

    // Update last used timestamp (non-blocking)
    prisma.apiKey.update({ where: { id: keyRecord.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

    req.userId = keyRecord.createdById;
    req.userRole = 'api';
    req.isApiKey = true;
    req.apiKeyPermissions = keyRecord.permissions;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'API key validation failed' });
  }
}

// ─── JWT AUTH MIDDLEWARE ───
async function authenticate(req, res, next) {
  // Check API key first
  if (req.headers['x-api-key']) return authenticateApiKey(req, res, next);

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check blacklist
    if (decoded.jti && await isBlacklisted(decoded.jti)) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }

    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.tokenJti = decoded.jti;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── PERMISSION MIDDLEWARE ───
function requirePermission(module, minLevel) {
  const levels = { none: 0, read: 1, edit: 2, full: 3 };
  return async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;

      // API keys with explicit role bypass
      if (req.isApiKey && req.userRole === 'admin') return next();

      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        include: { role: { include: { permissions: true } } },
      });
      if (!user || !user.active) {
        return res.status(403).json({ error: 'Account disabled' });
      }
      const perm = user.role.permissions.find(p => p.module === module);
      const userLevel = perm ? levels[perm.level] || 0 : 0;
      if (userLevel < (levels[minLevel] || 0)) {
        return res.status(403).json({ error: `Insufficient permissions for ${module}` });
      }
      req.user = user;
      req.permissionLevel = perm?.level || 'none';
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  authenticate,
  authenticateApiKey,
  requirePermission,
  signToken,
  signAccessToken,
  signRefreshToken,
  blacklistToken,
  isBlacklisted,
  setRedisClient,
  validatePassword,
  recordFailedLogin,
  clearLoginAttempts,
  isAccountLocked,
  getLockedUntil,
  getRemainingAttempts,
  JWT_SECRET,
  MAX_LOGIN_ATTEMPTS,
};
