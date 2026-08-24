const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticate, requirePermission, validatePassword, signAccessToken } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { createLimiter } = require('../middleware/rateLimit');
const {
  sendVerificationEmail,
  sendInviteEmail,
  sendWelcomeEmail,
} = require('../utils/mail');

const router = Router();

// Public endpoints are abuse targets, so they get their own tighter limits
const signupLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many signup attempts. Try again in a few minutes.' });
const verifyLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many verification attempts.' });

const VERIFY_TTL_HOURS = 48;
const INVITE_TTL_DAYS = 7;

function publicOrigin(req) {
  const raw = process.env.FRONTEND_URL || req.headers.origin || `${req.protocol}://${req.get('host')}`;
  return String(raw).replace(/\/$/, '');
}

/** Generate a token and its storage hash. The raw value is shown once. */
function makeToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function isValidEmail(email) {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
}

// Free providers are fine for self-hosted interest but flagged for review
const FREE_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com', 'gmx.com', 'yandex.com']);

// Disposable domains never get through
const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'throwawaymail.com', 'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com', 'temp-mail.org']);

function classifyEmail(email) {
  const domain = String(email).toLowerCase().split('@')[1] || '';
  return {
    domain,
    disposable: DISPOSABLE_DOMAINS.has(domain),
    freeProvider: FREE_DOMAINS.has(domain),
    business: !FREE_DOMAINS.has(domain) && !DISPOSABLE_DOMAINS.has(domain),
  };
}

/** Never leak whether an address is already known. */
function genericAccepted(email) {
  return {
    accepted: true,
    email,
    message: 'Check your inbox for a verification link. If you do not see it within a few minutes, check your spam folder.',
  };
}

// ── PUBLIC SIGNUP ─────────────────────────────────────────────────────

router.post('/', signupLimiter, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, firstName, lastName, company, companySize, role, phone, useCase, interestedIn, source, utmSource, utmCampaign } = req.body;

    if (!email) return res.status(400).json({ error: 'Email is required' });
    const clean = String(email).trim().toLowerCase();
    if (!isValidEmail(clean)) return res.status(400).json({ error: 'Enter a valid email address' });

    const classification = classifyEmail(clean);
    if (classification.disposable) {
      return res.status(400).json({ error: 'Use a permanent email address so we can reach you about your account.' });
    }
    if (interestedIn && !['cloud', 'self-hosted', 'both'].includes(interestedIn)) {
      return res.status(400).json({ error: 'interestedIn must be cloud, self-hosted, or both' });
    }

    // An existing user or a pending request both return the same response,
    // so this endpoint cannot be used to enumerate accounts.
    const existingUser = await prisma.user.findUnique({ where: { email: clean } }).catch(() => null);
    if (existingUser) return res.status(202).json(genericAccepted(clean));

    const { raw, hash } = makeToken();
    const expiresAt = new Date(Date.now() + VERIFY_TTL_HOURS * 3600000);

    const existing = await prisma.signupRequest.findFirst({
      where: { email: clean, status: { in: ['Pending', 'Verified'] } },
      orderBy: { createdAt: 'desc' },
    });

    let request;
    if (existing) {
      // Re-issue rather than duplicate, so a lost email is recoverable
      request = await prisma.signupRequest.update({
        where: { id: existing.id },
        data: {
          firstName: firstName ?? existing.firstName,
          lastName: lastName ?? existing.lastName,
          company: company ?? existing.company,
          companySize: companySize ?? existing.companySize,
          role: role ?? existing.role,
          phone: phone ?? existing.phone,
          useCase: useCase ?? existing.useCase,
          interestedIn: interestedIn || existing.interestedIn,
          verifyTokenHash: hash, verifyExpiresAt: expiresAt,
        },
      });
    } else {
      request = await prisma.signupRequest.create({
        data: {
          email: clean, firstName, lastName, company, companySize, role, phone, useCase,
          interestedIn: interestedIn || 'cloud',
          verifyTokenHash: hash, verifyExpiresAt: expiresAt,
          source: source || 'landing', utmSource, utmCampaign,
          ipAddress: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 45),
          userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        },
      });
    }

    const verifyUrl = `${publicOrigin(req)}/verify?token=${raw}`;

    await sendVerificationEmail({
      to: clean,
      firstName: firstName || request.firstName,
      verifyUrl,
    });

    // Raw token is returned only outside production so the flow is testable without SMTP.
    const payload = genericAccepted(clean);
    if (process.env.NODE_ENV !== 'production') payload.devVerifyUrl = verifyUrl;

    res.status(201).json(payload);
  } catch (err) { next(err); }
});

// Confirm ownership of the address
router.post('/verify', verifyLimiter, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Verification token is required' });

    const request = await prisma.signupRequest.findFirst({ where: { verifyTokenHash: hashToken(token) } });
    if (!request) return res.status(404).json({ error: 'That verification link is not valid. Request a new one.' });
    if (request.status === 'Converted') return res.status(409).json({ error: 'This request has already been converted to an account.' });
    if (request.verifiedAt) {
      return res.json({ verified: true, alreadyVerified: true, email: request.email, message: 'Your email is already confirmed. We will be in touch once your account is ready.' });
    }
    if (request.verifyExpiresAt && new Date() > new Date(request.verifyExpiresAt)) {
      return res.status(410).json({ error: 'That verification link has expired. Request a new one.', expired: true });
    }

    const updated = await prisma.signupRequest.update({
      where: { id: request.id },
      data: { status: 'Verified', verifiedAt: new Date(), verifyTokenHash: null, verifyExpiresAt: null },
    });

    res.json({
      verified: true, email: updated.email,
      message: 'Email confirmed. Your request is queued for review and you will receive an invite once it is approved.',
    });
  } catch (err) { next(err); }
});

router.post('/resend', signupLimiter, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const clean = String(email).trim().toLowerCase();

    const request = await prisma.signupRequest.findFirst({
      where: { email: clean, status: 'Pending' },
      orderBy: { createdAt: 'desc' },
    });

    // Same response either way, so this cannot confirm an address exists
    if (!request) return res.status(202).json(genericAccepted(clean));

    const { raw, hash } = makeToken();
    await prisma.signupRequest.update({
      where: { id: request.id },
      data: { verifyTokenHash: hash, verifyExpiresAt: new Date(Date.now() + VERIFY_TTL_HOURS * 3600000) },
    });

    const payload = genericAccepted(clean);
    const verifyUrl = `${publicOrigin(req)}/verify?token=${raw}`;
    await sendVerificationEmail({ to: clean, firstName: request.firstName, verifyUrl });
    if (process.env.NODE_ENV !== 'production') {
      payload.devVerifyUrl = verifyUrl;
    }
    res.status(202).json(payload);
  } catch (err) { next(err); }
});

// ── ADMIN REVIEW ──────────────────────────────────────────────────────

router.get('/requests', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, search, page = 1, limit = 50 } = req.query;

    const where = {};
    if (status) where.status = status;
    if (search) where.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
    ];

    const [data, total] = await Promise.all([
      prisma.signupRequest.findMany({
        where, skip: (+page - 1) * +limit, take: Math.min(+limit, 200),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, email: true, firstName: true, lastName: true, company: true,
          companySize: true, role: true, useCase: true, interestedIn: true,
          status: true, verifiedAt: true, source: true, utmSource: true,
          createdAt: true, rejectionReason: true,
        },
      }),
      prisma.signupRequest.count({ where }),
    ]);

    res.json({
      data: data.map(r => ({ ...r, emailClass: classifyEmail(r.email) })),
      total, page: +page, limit: +limit,
    });
  } catch (err) { next(err); }
});

router.get('/requests/stats', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 86400000);

    const all = await prisma.signupRequest.findMany({
      select: { status: true, createdAt: true, verifiedAt: true, interestedIn: true, companySize: true, utmSource: true, source: true, email: true },
      take: 20000,
    });
    const recent = all.filter(r => new Date(r.createdAt) >= since);
    const verified = all.filter(r => r.verifiedAt);

    const tally = (rows, key) => rows.reduce((a, r) => { const k = r[key] || 'Unspecified'; a[k] = (a[k] || 0) + 1; return a; }, {});

    res.json({
      periodDays: days,
      total: all.length,
      inPeriod: recent.length,
      pendingReview: all.filter(r => r.status === 'Verified').length,
      awaitingEmailConfirmation: all.filter(r => r.status === 'Pending').length,
      converted: all.filter(r => r.status === 'Converted').length,
      rejected: all.filter(r => r.status === 'Rejected').length,
      verificationRate: all.length ? +((verified.length / all.length) * 100).toFixed(1) : 0,
      businessEmails: all.filter(r => classifyEmail(r.email).business).length,
      byInterest: tally(all, 'interestedIn'),
      byCompanySize: tally(all, 'companySize'),
      bySource: tally(all, 'utmSource'),
    });
  } catch (err) { next(err); }
});

// Approve a request, which issues an invite rather than creating a user
router.post('/requests/:id/approve', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const request = await prisma.signupRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Signup request not found' });
    if (request.status === 'Converted') return res.status(409).json({ error: 'Already converted to an account' });
    if (!request.verifiedAt) return res.status(400).json({ error: 'Cannot approve a request whose email has not been confirmed' });

    const existingUser = await prisma.user.findUnique({ where: { email: request.email } }).catch(() => null);
    if (existingUser) return res.status(409).json({ error: 'A user already exists with that email' });

    let roleId = req.body.roleId;
    if (!roleId) {
      const fallback = await prisma.role.findFirst({ where: { name: 'Sales Rep' } });
      roleId = fallback?.id;
    }
    if (!roleId) return res.status(400).json({ error: 'roleId required; no default role exists' });

    const { raw, hash } = makeToken();
    const invite = await prisma.userInvite.create({
      data: {
        email: request.email, firstName: request.firstName, lastName: request.lastName,
        roleId, tokenHash: hash,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86400000),
        invitedById: req.user.id, signupRequestId: request.id,
        message: req.body.message || null,
      },
    });

    await prisma.signupRequest.update({
      where: { id: request.id },
      data: { status: 'Approved', reviewedById: req.user.id, reviewedAt: new Date() },
    });

    await req.audit({ action: 'update', module: 'signup', recordId: request.id, details: `Signup approved and invite issued: ${request.email}` });

    const inviteUrl = `${publicOrigin(req)}/accept-invite?token=${raw}`;
    await sendInviteEmail({
      to: request.email,
      firstName: request.firstName,
      inviteUrl,
      message: req.body.message || null,
    });
    const payload = { approved: true, inviteId: invite.id, email: request.email, expiresAt: invite.expiresAt };
    if (process.env.NODE_ENV !== 'production') payload.devInviteUrl = inviteUrl;
    res.status(201).json(payload);
  } catch (err) { next(err); }
});

router.post('/requests/:id/reject', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const request = await prisma.signupRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Signup request not found' });

    const updated = await prisma.signupRequest.update({
      where: { id: request.id },
      data: { status: 'Rejected', reviewedById: req.user.id, reviewedAt: new Date(), rejectionReason: req.body.reason || null },
    });
    await req.audit({ action: 'update', module: 'signup', recordId: request.id, details: `Signup rejected: ${request.email}` });
    res.json(updated);
  } catch (err) { next(err); }
});

// ── INVITES ───────────────────────────────────────────────────────────

router.get('/invites', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = {};
    if (req.query.status) where.status = req.query.status;

    const invites = await prisma.userInvite.findMany({
      where, orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(req.query.limit, 10) || 100, 300),
      select: {
        id: true, email: true, firstName: true, lastName: true, roleId: true,
        status: true, expiresAt: true, invitedById: true, acceptedAt: true,
        resendCount: true, lastSentAt: true, createdAt: true,
      },
    });

    const now = new Date();
    res.json(invites.map(i => ({ ...i, expired: i.status === 'Pending' && new Date(i.expiresAt) < now })));
  } catch (err) { next(err); }
});

router.post('/invites', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, firstName, lastName, roleId, message } = req.body;

    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const clean = String(email).trim().toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email: clean } }).catch(() => null);
    if (existingUser) return res.status(409).json({ error: 'A user already exists with that email' });

    const openInvite = await prisma.userInvite.findFirst({ where: { email: clean, status: 'Pending', expiresAt: { gt: new Date() } } });
    if (openInvite) return res.status(409).json({ error: 'An invite for that address is already outstanding', inviteId: openInvite.id });

    let role = roleId;
    if (!role) {
      const fallback = await prisma.role.findFirst({ where: { name: 'Sales Rep' } });
      role = fallback?.id;
    }
    if (!role) return res.status(400).json({ error: 'roleId required; no default role exists' });

    const { raw, hash } = makeToken();
    const invite = await prisma.userInvite.create({
      data: {
        email: clean, firstName, lastName, roleId: role, tokenHash: hash,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86400000),
        invitedById: req.user.id, message,
      },
    });

    await req.audit({ action: 'create', module: 'signup', recordId: invite.id, details: `Invite sent: ${clean}` });

    const inviteUrl = `${publicOrigin(req)}/accept-invite?token=${raw}`;
    await sendInviteEmail({ to: clean, firstName, inviteUrl, message });
    const payload = { id: invite.id, email: invite.email, expiresAt: invite.expiresAt, status: invite.status };
    if (process.env.NODE_ENV !== 'production') payload.devInviteUrl = inviteUrl;
    res.status(201).json(payload);
  } catch (err) { next(err); }
});

router.post('/invites/:id/revoke', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const invite = await prisma.userInvite.findUnique({ where: { id: req.params.id } });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status === 'Accepted') return res.status(409).json({ error: 'That invite has already been accepted' });

    await prisma.userInvite.update({ where: { id: invite.id }, data: { status: 'Revoked', tokenHash: `revoked-${invite.id}` } });
    await req.audit({ action: 'update', module: 'signup', recordId: invite.id, details: `Invite revoked: ${invite.email}` });
    res.json({ revoked: true });
  } catch (err) { next(err); }
});

router.post('/invites/:id/resend', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const invite = await prisma.userInvite.findUnique({ where: { id: req.params.id } });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'Pending') return res.status(409).json({ error: `Cannot resend an invite that is ${invite.status.toLowerCase()}` });
    if (invite.resendCount >= 5) return res.status(429).json({ error: 'Resend limit reached for this invite. Revoke it and issue a new one.' });

    const { raw, hash } = makeToken();
    const updated = await prisma.userInvite.update({
      where: { id: invite.id },
      data: {
        tokenHash: hash,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86400000),
        resendCount: { increment: 1 }, lastSentAt: new Date(),
      },
    });

    const payload = { resent: true, resendCount: updated.resendCount, expiresAt: updated.expiresAt };
    const inviteUrl = `${publicOrigin(req)}/accept-invite?token=${raw}`;
    await sendInviteEmail({
      to: invite.email,
      firstName: invite.firstName,
      inviteUrl,
      message: invite.message,
    });
    if (process.env.NODE_ENV !== 'production') {
      payload.devInviteUrl = inviteUrl;
    }
    res.json(payload);
  } catch (err) { next(err); }
});

// Public: read an invite so the accept screen can prefill and validate
router.get('/invites/lookup/:token', verifyLimiter, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const invite = await prisma.userInvite.findFirst({ where: { tokenHash: hashToken(req.params.token) } });
    if (!invite) return res.status(404).json({ error: 'That invite link is not valid.' });
    if (invite.status === 'Accepted') return res.status(409).json({ error: 'That invite has already been used.' });
    if (invite.status === 'Revoked') return res.status(403).json({ error: 'That invite has been revoked.' });
    if (new Date() > new Date(invite.expiresAt)) return res.status(410).json({ error: 'That invite has expired. Ask your administrator to send a new one.', expired: true });

    res.json({
      valid: true, email: invite.email,
      firstName: invite.firstName, lastName: invite.lastName,
      message: invite.message, expiresAt: invite.expiresAt,
    });
  } catch (err) { next(err); }
});

// Public: accept an invite, which is the only path that creates a user
router.post('/invites/accept', verifyLimiter, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { token, password, firstName, lastName } = req.body;
    if (!token) return res.status(400).json({ error: 'Invite token is required' });
    if (!password) return res.status(400).json({ error: 'Choose a password' });

    const invite = await prisma.userInvite.findFirst({ where: { tokenHash: hashToken(token) } });
    if (!invite) return res.status(404).json({ error: 'That invite link is not valid.' });
    if (invite.status === 'Accepted') return res.status(409).json({ error: 'That invite has already been used.' });
    if (invite.status === 'Revoked') return res.status(403).json({ error: 'That invite has been revoked.' });
    if (new Date() > new Date(invite.expiresAt)) {
      await prisma.userInvite.update({ where: { id: invite.id }, data: { status: 'Expired' } }).catch(() => {});
      return res.status(410).json({ error: 'That invite has expired. Ask your administrator to send a new one.' });
    }

    const pw = validatePassword(password);
    if (!pw.valid) return res.status(400).json({ error: 'Password does not meet requirements', details: pw.errors });

    const existingUser = await prisma.user.findUnique({ where: { email: invite.email } }).catch(() => null);
    if (existingUser) return res.status(409).json({ error: 'An account already exists for that address. Sign in instead.' });

    const first = firstName || invite.firstName;
    const last = lastName || invite.lastName;
    if (!first || !last) return res.status(400).json({ error: 'First and last name are required' });

    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email: invite.email, password: hash, firstName: first, lastName: last, roleId: invite.roleId },
      include: { role: { include: { permissions: true } } },
    });

    await prisma.userInvite.update({
      where: { id: invite.id },
      data: { status: 'Accepted', acceptedAt: new Date(), acceptedUserId: user.id, tokenHash: `used-${invite.id}` },
    });

    if (invite.signupRequestId) {
      await prisma.signupRequest.update({
        where: { id: invite.signupRequestId },
        data: { status: 'Converted', convertedUserId: user.id, convertedAt: new Date() },
      }).catch(() => {});
    }

    const accessToken = signAccessToken(user.id, user.role.name);
    const { password: _pw, ...safeUser } = user;

    await sendWelcomeEmail({ to: user.email, firstName: user.firstName }).catch((err) => {
      console.error('[welcome-email]', err.message);
    });

    res.status(201).json({ token: accessToken, user: safeUser });
  } catch (err) { next(err); }
});

// Housekeeping: mark lapsed invites and requests
router.post('/maintenance/expire', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const invites = await prisma.userInvite.updateMany({
      where: { status: 'Pending', expiresAt: { lt: now } },
      data: { status: 'Expired' },
    });
    const stale = await prisma.signupRequest.updateMany({
      where: { status: 'Pending', verifyExpiresAt: { lt: now } },
      data: { verifyTokenHash: null },
    });
    res.json({ invitesExpired: invites.count, verificationTokensCleared: stale.count });
  } catch (err) { next(err); }
});

module.exports = router;
