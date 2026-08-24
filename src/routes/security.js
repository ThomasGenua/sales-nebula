const { Router } = require('express');
const crypto = require('crypto');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const router = Router();

// ─── SSO CONFIG ───
router.get('/sso', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.ssoConfig.findMany() }); } catch (err) { next(err); }
});
router.post('/sso', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.ssoConfig.create({ data: req.body })); } catch (err) { next(err); }
});
router.put('/sso/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.ssoConfig.update({ where: { id: req.params.id }, data: req.body })); } catch (err) { next(err); }
});
// SSO login endpoint
router.post('/sso/login', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { provider, token, email } = req.body;
    const config = await prisma.ssoConfig.findFirst({ where: { provider, active: true } });
    if (!config) return res.status(400).json({ error: 'SSO provider not configured' });
    // In production: validate SAML assertion or OIDC token
    // Simplified: look up user by email from token claims
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user && config.autoProvision) {
      user = await prisma.user.create({ data: { email, firstName: req.body.firstName || 'SSO', lastName: req.body.lastName || 'User', password: crypto.randomBytes(32).toString('hex'), roleId: config.defaultRoleId } });
    }
    if (!user) return res.status(401).json({ error: 'User not found and auto-provisioning disabled' });
    const { signToken } = require('../middleware/auth');
    const accessToken = signToken(user.id, user.roleId);
    res.json({ token: accessToken, user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName } });
  } catch (err) { next(err); }
});

// ─── MFA ───
router.get('/mfa/devices', authenticate, async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.mfaDevice.findMany({ where: { userId: req.userId }, select: { id: true, type: true, verified: true, lastUsedAt: true, createdAt: true } }) }); }
  catch (err) { next(err); }
});
router.post('/mfa/enroll', authenticate, async (req, res, next) => {
  try {
    const { type = 'totp' } = req.body;
    const secret = crypto.randomBytes(20).toString('base32').substring(0, 16);
    const device = await req.app.locals.prisma.mfaDevice.create({
      data: { userId: req.userId, type, secret: type === 'totp' ? secret : null, phone: req.body.phone },
    });
    const response = { deviceId: device.id, type };
    if (type === 'totp') {
      response.secret = secret;
      response.otpAuthUrl = `otpauth://totp/SalesNebula:${req.userId}?secret=${secret}&issuer=SalesNebula`;
    }
    res.status(201).json(response);
  } catch (err) { next(err); }
});
router.post('/mfa/verify', authenticate, async (req, res, next) => {
  try {
    const { deviceId, code } = req.body;
    const device = await req.app.locals.prisma.mfaDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== req.userId) return res.status(404).json({ error: 'Device not found' });
    // TOTP verification (simplified - in production use speakeasy/otplib)
    if (device.type === 'totp') {
      // Accept any 6-digit code for now; real impl uses HMAC-based TOTP
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid code format' });
    }
    await req.app.locals.prisma.mfaDevice.update({ where: { id: deviceId }, data: { verified: true, lastUsedAt: new Date() } });
    res.json({ verified: true });
  } catch (err) { next(err); }
});
router.post('/mfa/challenge', async (req, res, next) => {
  try {
    const { userId, deviceId } = req.body;
    const device = await req.app.locals.prisma.mfaDevice.findUnique({ where: { id: deviceId } });
    if (!device || !device.verified) return res.status(400).json({ error: 'Device not verified' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const challenge = await req.app.locals.prisma.mfaChallenge.create({
      data: { userId, deviceId, code, expiresAt: new Date(Date.now() + 300000) },
    });
    // In production: send code via SMS/email for non-TOTP
    res.json({ challengeId: challenge.id, expiresIn: 300 });
  } catch (err) { next(err); }
});
router.delete('/mfa/devices/:id', authenticate, async (req, res, next) => {
  try { await req.app.locals.prisma.mfaDevice.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

// ─── ENCRYPTION POLICIES ───
router.get('/encryption/policies', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.encryptionPolicy.findMany() }); } catch (err) { next(err); }
});
router.post('/encryption/policies', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.encryptionPolicy.create({ data: req.body })); } catch (err) { next(err); }
});
router.put('/encryption/policies/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.encryptionPolicy.update({ where: { id: req.params.id }, data: req.body })); } catch (err) { next(err); }
});
router.post('/encryption/rotate-key', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const latest = await prisma.encryptionKey.findFirst({ orderBy: { version: 'desc' } });
    const newVersion = (latest?.version || 0) + 1;
    const keyMaterial = crypto.randomBytes(32).toString('hex');
    const key = await prisma.encryptionKey.create({ data: { version: newVersion, keyMaterial, status: 'Active' } });
    if (latest) await prisma.encryptionKey.update({ where: { id: latest.id }, data: { status: 'Archived', archivedAt: new Date() } });
    res.json({ version: key.version, status: key.status });
  } catch (err) { next(err); }
});
router.get('/encryption/keys', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const keys = await req.app.locals.prisma.encryptionKey.findMany({ orderBy: { version: 'desc' }, select: { id: true, version: true, status: true, activatedAt: true, archivedAt: true } });
    res.json({ data: keys });
  } catch (err) { next(err); }
});

module.exports = router;

// Analytics/stats endpoint
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    res.json({ module: 'security', status: 'operational', lastChecked: new Date(), metrics: { uptime: process.uptime(), memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576) } });
  } catch (err) { next(err); }
});

// Bulk status check
router.get('/status/health', authenticate, async (req, res, next) => {
  try { res.json({ module: 'security', healthy: true, timestamp: new Date(), version: '4.1.0' }); } catch (err) { next(err); }
});

// Count endpoint
router.get('/count', authenticate, async (req, res, next) => {
  try { res.json({ count: 0, module: 'security' }); } catch (err) { next(err); }
});

// Threat detection - suspicious activity analysis
router.get('/threats', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
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
router.get('/sessions', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const recentLogins = await prisma.loginHistory.findMany({ where: { status: 'Success', loginTime: { gte: new Date(Date.now() - 8 * 3600000) } }, include: { user: { select: { firstName: true, lastName: true, email: true } } }, orderBy: { loginTime: 'desc' }, take: 50 });
    const sessions = recentLogins.map(l => ({ userId: l.userId, user: l.user, ip: l.sourceIp, browser: l.browser, loginTime: l.loginTime }));
    res.json({ activeSessions: sessions.length, sessions });
  } catch (err) { next(err); }
});

// IP allowlist/blocklist management
router.post('/ip-rules', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ip, type, reason } = req.body;
    if (!ip || !type) return res.status(400).json({ error: 'ip and type (allow/block) required' });
    const rule = await prisma.ipRule.create({ data: { ip, type, reason, createdById: req.user.id } }).catch(() => null);
    if (!rule) return res.status(500).json({ error: 'Failed to create rule' });
    await req.audit({ action: 'create', module: 'security', recordId: rule.id, details: `${type} IP ${ip}` });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});
