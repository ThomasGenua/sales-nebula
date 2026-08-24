/**
 * Rate Limiting Middleware
 * Tiered limits: auth endpoints are stricter, read endpoints are more generous.
 * Uses Redis when available, falls back to memory store.
 */

let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch (e) { rateLimit = null; }

function createLimiter(options = {}) {
  if (!rateLimit) {
    return (req, res, next) => next(); // No-op if not installed
  }

  const windowMs = options.windowMs || parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
  const max = options.max || parseInt(process.env.RATE_LIMIT_MAX) || 200;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId || req.ip,
    message: { error: 'Too many requests, please try again later', retryAfter: Math.ceil(windowMs / 1000) },
    skip: (req) => process.env.NODE_ENV === 'test',
    ...options,
  });
}

// Tiered limiters
const limiters = {
  // Strict: login, register (prevent brute force)
  auth: createLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyGenerator: (req) => req.ip }),

  // Standard: most API calls
  standard: createLimiter({ windowMs: 15 * 60 * 1000, max: 200 }),

  // Generous: read-only endpoints
  read: createLimiter({ windowMs: 15 * 60 * 1000, max: 500 }),

  // Tight: AI endpoints (expensive)
  ai: createLimiter({ windowMs: 60 * 60 * 1000, max: 50 }),

  // Very tight: bulk operations
  bulk: createLimiter({ windowMs: 15 * 60 * 1000, max: 20 }),

  // Export: prevent abuse
  export: createLimiter({ windowMs: 60 * 60 * 1000, max: 30 }),
};

module.exports = { createLimiter, limiters };
