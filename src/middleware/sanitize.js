/**
 * Input Sanitization Middleware
 * Recursively sanitizes all string values in request body, query, and params.
 * Prevents XSS attacks by stripping dangerous HTML/JS content.
 */

let xss;
try { xss = require('xss'); } catch (e) { xss = null; }

// xss's own allow-list plus class and style, which it checks with its CSS
// filter (url(javascript:), expression() and unlisted properties go). Without
// them every saved document template lost its alignment and layout.
const filter = xss && new xss.FilterXSS({
  whiteList: Object.fromEntries(Object.entries(xss.getDefaultWhiteList())
    .map(([tag, attrs]) => [tag, [...attrs, 'class', 'style']])),
});

// A browser opens a tag only at "<" followed by a letter, "/", "!" or "?";
// a "<" that ends the value counts too, as the next value could finish it.
// Text with neither holds no markup. Filtering it anyway stored "x < 5" as
// "x &lt; 5", which the app then showed, and broke formulas like "value > 0".
const MAY_HOLD_MARKUP = /<(?:[a-z!/?]|$)/i;

// Recursive sanitizer for nested objects
function sanitizeValue(value) {
  if (typeof value === 'string') {
    if (filter) return MAY_HOLD_MARKUP.test(value) ? filter.process(value) : value;
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
