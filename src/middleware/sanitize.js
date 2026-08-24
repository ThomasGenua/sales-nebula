/**
 * Input Sanitization Middleware
 * Recursively sanitizes all string values in request body, query, and params.
 * Prevents XSS attacks by stripping dangerous HTML/JS content.
 */

let xss;
try { xss = require('xss'); } catch (e) { xss = null; }

// Recursive sanitizer for nested objects
function sanitizeValue(value) {
  if (typeof value === 'string') {
    if (xss) return xss(value);
    // Fallback: strip script tags and event handlers
    return value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/javascript:/gi, '');
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      clean[k] = sanitizeValue(v);
    }
    return clean;
  }
  return value;
}

// Express middleware
function sanitize(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeValue(req.params);
  }
  next();
}

module.exports = { sanitize, sanitizeValue };
