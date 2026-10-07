const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { generateSecret, verifyTotp, otpAuthUrl } = require('../utils/totp');
const bcrypt = require('bcryptjs');
const { limiters } = require('../middleware/rateLimit');
const { queryWithIncludes, pickModelFields } = require('../utils/modelFields');
const { statusRoutes } = require('../utils/moduleStatus');
const { unavailable } = require('../utils/unavailable');
const router = Router();

// ─── SSO CONFIG ───
// The client secret and signing certificate are written, never read back:
// listing configs returned them whole at admin: read, which the default Read
// Only role has. Responses say whether one is set.
const presentSso = ({ clientSecret, certificateData, ...config }) => ({
  ...config, hasClientSecret: !!clientSecret, hasCertificate: !!certificateData,
});
const ssoFields = body => {
  const { id, createdAt, updatedAt, ...rest } = body || {};
  return pickModelFields('ssoConfig', rest).data;
};
router.get('/sso', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try { res.json({ data: (await req.app.locals.prisma.ssoConfig.findMany()).map(presentSso) }); } catch (err) { next(err); }
});
router.post('/sso', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { res.status(201).json(presentSso(await req.app.locals.prisma.ssoConfig.create({ data: ssoFields(req.body) }))); } catch (err) { next(err); }
});
router.put('/sso/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { res.json(presentSso(await req.app.locals.prisma.ssoConfig.update({ where: { id: req.params.id }, data: ssoFields(req.body) }))); } catch (err) { next(err); }
});
// SSO login endpoint
/**
 * SSO sign-in is deliberately disabled.
 *
 * This route used to take { provider, token, email } from the request body,
 * never verify `token`, look the user up by the supplied email and issue a
 * valid session. It is unauthenticated, so anyone who could reach the API
 * could sign in as any user — including an administrator — by naming their
 * address, and with autoProvision could create accounts outright.
 *
 * Verifying an assertion properly needs a SAML or OIDC library and per-provider
 * certificate handling, neither of which is present. Until that exists this
 * refuses rather than pretending. The /sso config endpoints above still work,
 * so nothing an administrator has already set up is lost.
 */
router.post('/sso/login', async (req, res) => {
  res.status(501).json({
    error: 'SSO sign-in is not implemented',
    detail: 'This deployment cannot verify SAML assertions or OIDC tokens. Use password sign-in at /api/auth/login.',
  });
});

// ─── MFA ───

/**
 * Adding or removing a second factor takes the account's password, as a new
 * sign-in email does. With a session alone, a thief could lock the owner out
 * behind a device of their own, or strip the one the owner has.
 */
async function passwordConfirmed(req) {
  const { currentPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword) return false;
  const user = await req.app.locals.prisma.user.findUnique({ where: { id: req.userId }, select: { password: true } });
  return !!user && bcrypt.compare(currentPassword, user.password);
}

const passwordRequired = res => res.status(403).json({
  error: 'Enter your current password to change two-factor authentication',
  code: 'PASSWORD_REQUIRED',
});

router.get('/mfa/devices', authenticate, async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.mfaDevice.findMany({ where: { userId: req.userId }, select: { id: true, type: true, verified: true, lastUsedAt: true, createdAt: true } }) }); }
  catch (err) { next(err); }
});
// Per user (limiters.account), not the per-address sign-in counter.
router.post('/mfa/enroll', authenticate, limiters.account, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await passwordConfirmed(req))) return passwordRequired(res);
    const { type = 'totp' } = req.body;
    // Only an authenticator app can work: no SMS or email code is ever sent.
    // Any other type was "verified" with whatever code was typed, and from
    // then on sign-in asked for a code that never arrived.
    if (type !== 'totp') return res.status(400).json({ error: 'Only authenticator-app (totp) devices are supported' });
    // crypto's Buffer has no 'base32' encoding, so the previous call threw
    // "Unknown encoding: base32" and enrolment never once succeeded.
    const secret = type === 'totp' ? generateSecret() : null;
    const device = await prisma.mfaDevice.create({
      data: { userId: req.userId, type, secret, phone: req.body.phone },
    });
    const response = { deviceId: device.id, type };
    if (type === 'totp') {
      const owner = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } });
      response.secret = secret;
      response.otpAuthUrl = otpAuthUrl({ secret, label: owner?.email || req.userId });
    }
    res.status(201).json(response);
  } catch (err) { next(err); }
});
// Rate limited: a six-digit code can be guessed, given enough tries.
router.post('/mfa/verify', authenticate, limiters.account, async (req, res, next) => {
  try {
    const { deviceId, code } = req.body;
    const device = await req.app.locals.prisma.mfaDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== req.userId) return res.status(404).json({ error: 'Device not found' });
    // This used to accept any six digits, so 000000 enrolled a device and the
    // "verified" flag meant nothing. Now the code has to match the secret, and
    // a device with no secret to match (not totp) cannot be verified at all.
    if (device.type !== 'totp') return res.status(400).json({ error: 'Only authenticator-app (totp) devices can be verified' });
    if (device.type === 'totp') {
      if (!verifyTotp(device.secret, code)) {
        return res.status(400).json({ error: 'Incorrect code' });
      }
    }
    await req.app.locals.prisma.mfaDevice.update({ where: { id: deviceId }, data: { verified: true, lastUsedAt: new Date() } });
    res.json({ verified: true });
  } catch (err) { next(err); }
});
/**
 * Issue an SMS/email code. Takes the short-lived mfaToken that /api/auth/login
 * hands back, rather than a userId from the body: the old version let anyone
 * mint challenges for any account they could name.
 */
// Before sign-in, per address. Nothing delivers a code by SMS or email: this
// stored one and answered as if it were on its way, and the user waited for
// it. The authenticator app's codes are the second factor.
router.post('/mfa/challenge', limiters.auth, (req, res) => unavailable(res, 'MFA_CODE_DELIVERY_UNAVAILABLE',
  'Sending a sign-in code by SMS or email is not available. Use the code from your authenticator app. No code was sent.'));
// Only the caller's own device. This deleted any account's device by id, so
// anyone signed in could strip an administrator's second factor.
router.delete('/mfa/devices/:id', authenticate, limiters.account, async (req, res, next) => {
  try {
    if (!(await passwordConfirmed(req))) return passwordRequired(res);
    const { count } = await req.app.locals.prisma.mfaDevice.deleteMany({ where: { id: req.params.id, userId: req.userId } });
    if (!count) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── ENCRYPTION POLICIES ───
router.get('/encryption/policies', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.encryptionPolicy.findMany() }); } catch (err) { next(err); }
});
// Nothing encrypts records by policy, and no key in EncryptionKey encrypts
// anything (secrets are sealed with the server's own key, utils/secretBox):
// a policy or a rotated key protected nothing while it said it did.
const ENCRYPTION = "Encryption policies are not available: nothing encrypts records by policy, and no key encrypts any data.";
router.post('/encryption/policies', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'ENCRYPTION_UNAVAILABLE', `${ENCRYPTION} No policy was saved.`));
router.put('/encryption/policies/:id', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'ENCRYPTION_UNAVAILABLE', `${ENCRYPTION} No policy was changed.`));
router.post('/encryption/rotate-key', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'ENCRYPTION_UNAVAILABLE', `${ENCRYPTION} No key was rotated.`));
router.get('/encryption/keys', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const keys = await req.app.locals.prisma.encryptionKey.findMany({ orderBy: { version: 'desc' }, select: { id: true, version: true, status: true, activatedAt: true, archivedAt: true } });
    res.json({ data: keys });
  } catch (err) { next(err); }
});

module.exports = router;

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'security', analytics: true });

// Threat detection - suspicious activity analysis
// Failed sign-ins and active sessions are other users' sign-in records, with
// their IP addresses: users read as well as admin read, as login history takes.
router.get('/threats', authenticate, requirePermission('admin', 'read'), requirePermission('users', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const since = new Date(Date.now() - 24 * 3600000);
    const [failedLogins, multiIpUsers, afterHoursAccess, bulkExports] = await Promise.all([
      prisma.loginHistory.findMany({ where: { status: 'Failed', loginTime: { gte: since } }, select: { userId: true, sourceIp: true, loginTime: true } }),
      prisma.loginHistory.groupBy({ by: ['userId'], where: { loginTime: { gte: since }, status: 'Success' }, _count: true, having: { sourceIp: { _count: { gt: 3 } } } }).catch(() => []),
      prisma.loginHistory.count({ where: { loginTime: { gte: since }, status: 'Success' } }),
      prisma.auditLog.count({ where: { module: 'export', createdAt: { gte: since } } }),
    ]);
    const ipFailCounts = {};
    failedLogins.forEach(f => { ipFailCounts[f.sourceIp] = (ipFailCounts[f.sourceIp] || 0) + 1; });
    const bruteForceIps = Object.entries(ipFailCounts).filter(([, c]) => c >= 5).map(([ip, count]) => ({ ip, attempts: count }));
    const threats = [];
    if (bruteForceIps.length) threats.push({ severity: 'high', type: 'brute_force', details: `${bruteForceIps.length} IPs with 5+ failed attempts`, data: bruteForceIps });
    if (bulkExports > 10) threats.push({ severity: 'medium', type: 'bulk_export', details: `${bulkExports} data exports in 24 hours` });
    if (failedLogins.length > 50) threats.push({ severity: 'medium', type: 'failed_logins', details: `${failedLogins.length} failed logins in 24 hours` });
    res.json({ threats, summary: { failedLogins: failedLogins.length, bruteForceIps: bruteForceIps.length, bulkExports, period: '24h' } });
  } catch (err) { next(err); }
});

// Active sessions
router.get('/sessions', authenticate, requirePermission('admin', 'read'), requirePermission('users', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const recentLogins = await queryWithIncludes(prisma, 'loginHistory', 'findMany', { where: { status: 'Success', loginTime: { gte: new Date(Date.now() - 8 * 3600000) } }, include: { user: { select: { firstName: true, lastName: true, email: true } } }, orderBy: { loginTime: 'desc' }, take: 50 });
    const sessions = recentLogins.map(l => ({ userId: l.userId, user: l.user, ip: l.sourceIp, browser: l.browser, loginTime: l.loginTime }));
    res.json({ activeSessions: sessions.length, sessions });
  } catch (err) { next(err); }
});

// IP allowlist/blocklist management
// Nothing checks an address against these rules at sign-in or on any request,
// so an allow or block rule protected nothing while it said it did.
router.post('/ip-rules', authenticate, requirePermission('admin', 'full'), (req, res) => unavailable(res, 'IP_RULES_UNAVAILABLE',
  'IP allow and block rules are not available: nothing would check them, at sign-in or after. No rule was saved.'));
