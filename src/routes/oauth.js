/**
 * OAuth2 / SSO Routes
 * Supports Google and Microsoft authentication.
 * Flow: Frontend gets auth code -> sends to backend -> backend exchanges for user info -> JWT
 */

const { Router } = require('express');
const { signToken } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = Router();

// POST /api/oauth/google - Exchange Google auth code for JWT
router.post('/google', async (req, res, next) => {
  try {
    const { credential, code } = req.body;
    const prisma = req.app.locals.prisma;

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google OAuth not configured' });
    }

    let email, firstName, lastName, avatar;

    if (credential) {
      // ID Token flow (from Google Sign-In button)
      let OAuth2Client;
      try { ({ OAuth2Client } = require('google-auth-library')); } catch (e) {
        return res.status(503).json({ error: 'google-auth-library not installed' });
      }
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      email = payload.email;
      firstName = payload.given_name || payload.name?.split(' ')[0] || '';
      lastName = payload.family_name || payload.name?.split(' ').slice(1).join(' ') || '';
      avatar = payload.picture;
    } else if (code) {
      // Authorization code flow
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${process.env.FRONTEND_URL}/oauth/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) return res.status(400).json({ error: 'Failed to exchange code' });

      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const profile = await userRes.json();
      email = profile.email;
      firstName = profile.given_name || '';
      lastName = profile.family_name || '';
      avatar = profile.picture;
    } else {
      return res.status(400).json({ error: 'credential or code required' });
    }

    // Find or create user
    let user = await prisma.user.findUnique({ where: { email }, include: { role: { include: { permissions: true } } } });

    if (!user) {
      // Auto-create with default role
      const defaultRole = await prisma.role.findFirst({ where: { name: 'Sales Rep' } });
      if (!defaultRole) return res.status(500).json({ error: 'No default role found' });

      user = await prisma.user.create({
        data: {
          email,
          password: '', // No password for OAuth users
          firstName,
          lastName,
          avatar: avatar || `${firstName[0]}${lastName[0]}`.toUpperCase(),
          roleId: defaultRole.id,
        },
        include: { role: { include: { permissions: true } } },
      });
    }

    if (!user.active) return res.status(403).json({ error: 'Account disabled' });

    const token = signToken(user.id, user.role.name);
    await audit(prisma, { action: 'login', module: 'auth', details: `OAuth Google login: ${email}`, userId: user.id });

    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser, provider: 'google' });
  } catch (err) { next(err); }
});

// POST /api/oauth/microsoft - Exchange Microsoft auth code for JWT
router.post('/microsoft', async (req, res, next) => {
  try {
    const { code } = req.body;
    const prisma = req.app.locals.prisma;

    if (!process.env.MICROSOFT_CLIENT_ID) {
      return res.status(503).json({ error: 'Microsoft OAuth not configured' });
    }

    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';

    // Exchange code for token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: `${process.env.FRONTEND_URL}/oauth/callback`,
        grant_type: 'authorization_code',
        scope: 'openid profile email User.Read',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.status(400).json({ error: 'Failed to exchange code', details: tokens.error_description });

    // Get user profile
    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    const email = profile.mail || profile.userPrincipalName;
    const firstName = profile.givenName || '';
    const lastName = profile.surname || '';

    // Find or create user
    let user = await prisma.user.findUnique({ where: { email }, include: { role: { include: { permissions: true } } } });

    if (!user) {
      const defaultRole = await prisma.role.findFirst({ where: { name: 'Sales Rep' } });
      if (!defaultRole) return res.status(500).json({ error: 'No default role found' });

      user = await prisma.user.create({
        data: { email, password: '', firstName, lastName, avatar: `${firstName[0]}${lastName[0]}`.toUpperCase(), roleId: defaultRole.id },
        include: { role: { include: { permissions: true } } },
      });
    }

    if (!user.active) return res.status(403).json({ error: 'Account disabled' });

    const token = signToken(user.id, user.role.name);
    await audit(prisma, { action: 'login', module: 'auth', details: `OAuth Microsoft login: ${email}`, userId: user.id });

    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser, provider: 'microsoft' });
  } catch (err) { next(err); }
});

// GET /api/oauth/config - Return OAuth config for frontend
router.get('/config', (req, res) => {
  res.json({
    google: { enabled: !!process.env.GOOGLE_CLIENT_ID, clientId: process.env.GOOGLE_CLIENT_ID || null },
    microsoft: { enabled: !!process.env.MICROSOFT_CLIENT_ID, clientId: process.env.MICROSOFT_CLIENT_ID || null, tenantId: process.env.MICROSOFT_TENANT_ID || 'common' },
  });
});

module.exports = router;
