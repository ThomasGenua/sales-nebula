/**
 * Authentication & Authorization Middleware (Production-Hardened)
 * 
 * Features:
 * - JWT access tokens (short-lived, 15min) + refresh tokens (7d)
 * - Token blacklist for revocation (Redis or in-memory)
 * - Account lockout after failed attempts
 * - Password complexity validation
 * - API key auth for service-to-service calls
 * - Connected-app OAuth tokens, limited to the scopes a user granted
 * - Role-based permission checks (4 tiers per module)
 */

const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const { resolveJwtSecret } = require('../utils/secrets');
const { ACCESS_COOKIE, readCookie, csrfValid, needsCsrf } = require('../utils/sessionCookies');
const { hashApiKey } = require('../utils/apiKeys');
const { ACCESS_TOKEN_PREFIX, findAccessGrant, appTokenRefusal } = require('../services/oauth');
const { isAdmin } = require('./rowSecurity');

const JWT_SECRET = resolveJwtSecret();
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

// ─── CUSTOMER PORTAL ACCOUNTS ───
// A portal account (User.isPortalUser) belongs to a customer's contact. It
// signs in like staff, and its session used to open every route that checks
// only for one: search, feeds, notes, calendars, timelines. It now reaches
// its own account and the portal, and nothing else.
const PORTAL_ROUTES = [
  { method: 'GET', path: '/api/auth/me' },
  { method: 'PUT', path: '/api/auth/me' },
  { method: 'POST', path: '/api/auth/change-password' },
  { prefix: '/api/security/mfa' },
  { prefix: '/api/portal/my' },
  { method: 'GET', path: '/api/portal/config' },
  { method: 'PUT', pattern: /^\/api\/portal\/users\/[^/]+\/profile$/ },
];

/** Why a portal account may not make this request, or null when it may. */
function portalRefusal(req) {
  const path = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase().replace(/\/+$/, '');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const allowed = PORTAL_ROUTES.some(route => {
    if (route.prefix) return path === route.prefix || path.startsWith(`${route.prefix}/`);
    if (route.method !== method) return false;
    return route.pattern ? route.pattern.test(path) : path === route.path;
  });
  return allowed ? null : 'Customer portal accounts can only use the portal';
}

/** Refuse a portal account anything outside the portal. True when it did. */
function refusedToPortalAccount(req, res, user) {
  if (!user?.isPortalUser) return false;
  const refusal = portalRefusal(req);
  if (!refusal) return false;
  res.status(403).json({ error: refusal, code: 'PORTAL_ACCOUNT' });
  return true;
}

const LEVELS = { none: 0, read: 1, edit: 2, full: 3 };

/** Whether a user's role grants at least `level` on a module, as requirePermission decides. */
function hasPermission(user, module, level) {
  const perm = user?.role?.permissions?.find(p => p.module === module);
  return (LEVELS[perm?.level] || 0) >= (LEVELS[level] || 0);
}

// ─── NOBODY GRANTS MORE THAN THEY HOLD ───

/**
 * Why `granter` may not hand out, or act on an account holding, a role with
 * this name and these permissions, or null when they may. No module may go
 * above the granter's own level, and only an administrator may deal in an
 * administrator role, since row security lets a role named Admin see every
 * record whatever its permissions.
 */
function roleCeilingRefusal(granter, role) {
  if (isAdmin(granter)) return null;
  if (isAdmin({ role: { name: role?.name } })) return 'Only an administrator can grant or manage an administrator role';
  const over = (role?.permissions || []).find(p => (LEVELS[p.level] || 0) > (LEVELS[
    granter?.role?.permissions?.find(g => g.module === p.module)?.level
  ] || 0));
  return over ? `That needs more access than you have yourself (${over.module}: ${over.level})` : null;
}

/** Why `granter` may not give someone the role `roleId`, or null. */
async function roleGrantRefusal(prisma, granter, roleId) {
  const role = roleId
    ? await prisma.role.findUnique({ where: { id: String(roleId) }, include: { permissions: true } })
    : null;
  if (!role) return 'Role not found';
  return roleCeilingRefusal(granter, role);
}

// ─── API KEY RATE LIMIT ───
// A key's rateLimit is requests per hour. It was stored and never enforced.
// Counted in Redis when there is one, so every instance shares the count;
// otherwise in this process.
const HOUR_MS = 60 * 60 * 1000;
const keyWindows = new Map(); // key id -> { windowStart, count }

async function countApiKeyRequest(keyId) {
  const windowStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const resetAt = windowStart + HOUR_MS;
  if (redisClient) {
    try {
      const name = `rl:apikey:${keyId}:${windowStart}`;
      const count = await redisClient.incr(name);
      if (count === 1) await redisClient.pexpire(name, HOUR_MS);
      return { count, resetAt };
    } catch (e) { /* fall back to memory */ }
  }
  let window = keyWindows.get(keyId);
  if (!window || window.windowStart !== windowStart) {
    window = { windowStart, count: 0 };
    keyWindows.set(keyId, window);
  }
  window.count += 1;
  if (keyWindows.size > 10000) {
    for (const [id, w] of keyWindows) if (w.windowStart !== windowStart) keyWindows.delete(id);
  }
  return { count: window.count, resetAt };
}

// ─── API KEY AUTH ───
async function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next(); // Fall through to JWT auth

  try {
    const prisma = req.app.locals.prisma;
    const keyRecord = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(apiKey) } });
    if (!keyRecord) return res.status(401).json({ error: 'Invalid API key' });
    if (!keyRecord.active) return res.status(401).json({ error: 'API key disabled' });
    if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
      return res.status(401).json({ error: 'API key expired' });
    }

    // Update last used timestamp (non-blocking)
    prisma.apiKey.update({ where: { id: keyRecord.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

    // A key acts for the user who made it, and not after they are gone or
    // disabled: routes without a permission check used to take such a key.
    const owner = await loadUser(req, keyRecord.createdById);
    if (!owner || !owner.active) return res.status(401).json({ error: 'API key owner is disabled' });
    if (refusedToPortalAccount(req, res, owner)) return;

    if (keyRecord.rateLimit > 0) {
      const { count, resetAt } = await countApiKeyRequest(keyRecord.id);
      res.set({
        'X-RateLimit-Limit': String(keyRecord.rateLimit),
        'X-RateLimit-Remaining': String(Math.max(0, keyRecord.rateLimit - count)),
        'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
      });
      if (count > keyRecord.rateLimit) {
        const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'API key rate limit exceeded', code: 'RATE_LIMITED', retryAfter });
      }
    }

    req.userId = keyRecord.createdById;
    req.userRole = 'api';
    req.user = owner;
    req.isApiKey = true;
    req.apiKeyPermissions = keyRecord.permissions;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'API key validation failed' });
  }
}

// ─── CONNECTED-APP TOKENS ───
/**
 * An access token a connected app was given with a user's consent (see
 * services/oauth). It acts as that user, within the scopes they granted.
 */
async function authenticateAppToken(req, res, next, token) {
  const bearerError = (status, error, description, body) => {
    res.set('WWW-Authenticate', `Bearer error="${error}", error_description="${description}"`);
    return res.status(status).json(body);
  };
  try {
    const prisma = req.app.locals.prisma;
    const { grant, reason } = await findAccessGrant(prisma, token);
    if (reason === 'expired') {
      return bearerError(401, 'invalid_token', 'The access token expired', { error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (!grant) return bearerError(401, 'invalid_token', 'The access token is invalid', { error: 'Invalid token' });

    const owner = await loadUser(req, grant.userId);
    if (!owner || !owner.active) {
      return bearerError(401, 'invalid_token', 'The access token is invalid', { error: 'Invalid token' });
    }
    if (refusedToPortalAccount(req, res, owner)) return;
    const refusal = appTokenRefusal(req, grant.scopes);
    if (refusal) {
      return bearerError(403, 'insufficient_scope', refusal, { error: refusal, code: 'INSUFFICIENT_SCOPE' });
    }

    req.userId = owner.id;
    req.userRole = 'app';
    req.user = owner;
    req.isAppToken = true;
    req.connectedAppId = grant.appId;
    req.oauthScopes = grant.scopes;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token validation failed' });
  }
}

/** The authenticated user, with role and permissions, cached on the request. */
async function loadUser(req, userId) {
  if (req.user && req.user.id === userId) return req.user;
  const prisma = req.app?.locals?.prisma;
  if (!prisma || !userId) return null;
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      include: { role: { include: { permissions: true } } },
    });
  } catch (err) {
    return null;
  }
}

// ─── JWT AUTH MIDDLEWARE ───
async function authenticate(req, res, next) {
  // Check API key first
  if (req.headers['x-api-key']) return authenticateApiKey(req, res, next);

  // A Bearer header (scripts, tests, API clients), else the browser's
  // httpOnly session cookie (see utils/sessionCookies).
  const header = req.headers.authorization;
  let token = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if (token && token.startsWith(ACCESS_TOKEN_PREFIX)) return authenticateAppToken(req, res, next, token);
  const viaCookie = !token;
  if (viaCookie) token = readCookie(req, ACCESS_COOKIE);
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  // The browser attaches the cookie to forged cross-site requests too; only
  // the page itself can echo the CSRF token back.
  if (viaCookie && needsCsrf(req) && !csrfValid(req)) {
    return res.status(403).json({ error: 'CSRF token missing or invalid', code: 'CSRF_FAILED' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check blacklist
    if (decoded.jti && await isBlacklisted(decoded.jti)) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }

    // Only a session access token opens the API. Every JWT this app signs
    // shares one secret, and this used to accept any of them carrying a
    // userId: the seven-day refresh token, and the connected-app token that
    // /connected-apps/oauth/token minted for any user id it was handed.
    // Connected apps now get opaque tokens, handled above.
    if (decoded.type !== 'access') return res.status(401).json({ error: 'Invalid token type' });

    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.tokenJti = decoded.jti;

    // Attach the user itself. 205 references across 50 route files read
    // `req.user.id`, but only requirePermission() ever loaded it, so every one
    // of those on an authenticate-only route threw "Cannot read properties of
    // undefined". Loading it here also means a token outlives neither the
    // account it belongs to nor that account being deactivated.
    const user = await loadUser(req, decoded.userId);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    if (!user.active) return res.status(403).json({ error: 'Account disabled' });
    if (refusedToPortalAccount(req, res, user)) return;
    req.user = user;

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
  const levels = LEVELS;
  return async (req, res, next) => {
    try {
      const user = await loadUser(req, req.userId);
      if (!user || !user.active) {
        return res.status(403).json({ error: 'Account disabled' });
      }
      const perm = user.role.permissions.find(p => p.module === module);
      let userLevel = perm ? levels[perm.level] || 0 : 0;
      // An API key reaches no further than the modules it was granted,
      // [{ module, level }], and never past its owner's own access. The grant
      // was stored and ignored, so a "contacts: read" key had its creator's
      // full rights. A key granted nothing carries its owner's access, as
      // keys always have.
      const grants = req.isApiKey && Array.isArray(req.apiKeyPermissions) ? req.apiKeyPermissions : [];
      if (grants.length) {
        const grant = grants.find(g => g.module === module || g.module === '*');
        userLevel = Math.min(userLevel, grant ? levels[grant.level] || 0 : 0);
      }
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
  hasPermission,
  portalRefusal,
  roleCeilingRefusal,
  roleGrantRefusal,
  PERMISSION_LEVELS: LEVELS,
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
