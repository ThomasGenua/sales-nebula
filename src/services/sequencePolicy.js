const crypto = require('crypto');
const { appUrl } = require('../utils/mail');
const TOKENS = ['firstName', 'lastName', 'fullName', 'company', 'email'];
function windowProblem(window) {
  if (window == null) return null;
  if (!window || typeof window !== 'object' || Array.isArray(window)) return 'Sending window must be an object';
  try { new Intl.DateTimeFormat('en-US', { timeZone: window.timezone }).format(); } catch { return 'Choose a valid sending time zone'; }
  if (typeof window.timezone !== 'string' || !Array.isArray(window.days) || !window.days.length || window.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return 'Choose at least one valid sending day';
  if (!Number.isInteger(window.start) || !Number.isInteger(window.end) || window.start < 0 || window.end > 1440 || window.start >= window.end) return 'Sending hours must start and end on the same day';
  return null;
}
function nextAllowed(window, now = new Date()) {
  if (!window) return now;
  const problem = windowProblem(window); if (problem) throw new Error(problem);
  const format = new Intl.DateTimeFormat('en-US', { timeZone: window.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i <= 8 * 1440; i++) {
    const date = i ? new Date(Math.ceil(now.getTime() / 60000) * 60000 + (i - 1) * 60000) : now;
    const parts = Object.fromEntries(format.formatToParts(date).map(p => [p.type, p.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    if (window.days.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)) && minute >= window.start && minute < window.end) return date;
  }
  throw new Error('No sending window found');
}
function templateProblem(text) {
  const unknown = [...String(text || '').matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(m => m[1]).filter(key => !TOKENS.includes(key));
  return unknown.length ? 'Unknown merge field: ' + unknown[0] : null;
}
function personalize(text, person) {
  const problem = templateProblem(text); if (problem) throw new Error(problem);
  const data = { ...person, fullName: [person.firstName, person.lastName].filter(Boolean).join(' '), company: person.company || person.account?.name || '' };
  return String(text || '').replace(/{{\s*([^{}]+?)\s*}}/g, (_, key) => String(data[key] || ''));
}
function signature(id) {
  return crypto.createHmac('sha256', require('../utils/secrets').resolveJwtSecret()).update('sequence-unsubscribe:' + id).digest('hex');
}
const unsubscribeUrl = id => appUrl('/api/public/sequences/' + id + '/unsubscribe?token=' + signature(id));
function validToken(id, token) { return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && crypto.timingSafeEqual(Buffer.from(signature(id), 'hex'), Buffer.from(token, 'hex')); }
module.exports = { TOKENS, windowProblem, nextAllowed, templateProblem, personalize, unsubscribeUrl, validToken };
