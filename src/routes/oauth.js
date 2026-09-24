/**
 * OAuth2 / SSO Routes
 * Supports Google and Microsoft authentication.
 * Flow: Frontend gets auth code -> sends to backend -> backend exchanges for user info -> session
 *
 * Social sign-in lets in whoever the provider vouches for, so it is off unless
 * OAUTH_LOGIN_ENABLED=true as well as a client id, and it signs in only an
 * existing, active account. It used to create a Sales Rep account for any
 * Google or Microsoft address (open registration by another door), took
 * unverified Google addresses, and let any Microsoft tenant name any address.
 * It now ends as a password sign-in does: MFA step, then the same session.
 */

const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { limiters } = require('../middleware/rateLimit');
const { appUrl } = require('../utils/mail');
const { completeSignIn, findAccountByEmail } = require('./auth');

const router = Router();

const enabled = clientId => process.env.OAUTH_LOGIN_ENABLED === 'true' && !!clientId;

// Microsoft's shared tenants take accounts from any directory, whose admins
// can set any mail address; only this organisation's own tenant id will do.
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const microsoftTenant = () => {
  const id = String(process.env.MICROSOFT_TENANT_ID || '').trim();
  return TENANT_ID.test(id) ? id.toLowerCase() : null;
};

/** The existing, active account an address verified by the provider signs in to, or why not. */
async function accountFor(prisma, email) {
  const user = typeof email === 'string' && email
    ? await findAccountByEmail(prisma, email, { include: { role: { include: { permissions: true } } } })
    : null;
  if (!user) return { status: 403, error: 'No account uses that address. Ask your administrator for an invite.' };
  if (!user.active) return { status: 403, error: 'Account disabled. Contact your administrator.' };
  return { user };
}

// POST /api/oauth/google - Exchange Google auth code for a session
router.post('/google', limiters.auth, async (req, res, next) => {
  try {
    const { credential, code } = req.body;
    const prisma = req.app.locals.prisma;

    if (!enabled(process.env.GOOGLE_CLIENT_ID)) {
      return res.status(503).json({ error: 'Google sign-in is not enabled' });
    }

    let email, verified;

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
      verified = payload.email_verified === true;
    } else if (code) {
      // Authorization code flow
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: appUrl('/oauth/callback'),
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
      verified = profile.verified_email === true;
    } else {
      return res.status(400).json({ error: 'credential or code required' });
    }

    // An address Google has not verified is only a claim to it.
    if (!verified) return res.status(403).json({ error: 'Google has not verified that email address' });

    const { user, status, error } = await accountFor(prisma, email);
    if (error) return res.status(status).json({ error });
    return completeSignIn(prisma, user, req, res, 'sso');
  } catch (err) { next(err); }
});

// POST /api/oauth/microsoft - Exchange Microsoft auth code for a session
router.post('/microsoft', limiters.auth, async (req, res, next) => {
  try {
    const { code } = req.body;
    const prisma = req.app.locals.prisma;

    if (!enabled(process.env.MICROSOFT_CLIENT_ID)) {
      return res.status(503).json({ error: 'Microsoft sign-in is not enabled' });
    }
    const tenantId = microsoftTenant();
    if (!tenantId) {
      return res.status(503).json({ error: 'Microsoft sign-in needs MICROSOFT_TENANT_ID set to your directory\'s tenant id (a GUID, not "common")' });
    }
    if (!code) return res.status(400).json({ error: 'code required' });

    // Exchange code for token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: appUrl('/oauth/callback'),
        grant_type: 'authorization_code',
        scope: 'openid profile email User.Read',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.status(400).json({ error: 'Failed to exchange code', details: tokens.error_description });

    // The ID token came straight from the token endpoint over TLS, so its
    // claims are read as sent (OIDC Core 3.1.3.7): it must be for this app,
    // from this organisation's directory.
    const claims = jwt.decode(tokens.id_token || '') || {};
    if (String(claims.tid || '').toLowerCase() !== tenantId || claims.aud !== process.env.MICROSOFT_CLIENT_ID) {
      return res.status(403).json({ error: 'That Microsoft account is not in this organisation\'s directory' });
    }

    // Get user profile
    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    const email = profile.mail || profile.userPrincipalName;

    const { user, status, error } = await accountFor(prisma, email);
    if (error) return res.status(status).json({ error });
    return completeSignIn(prisma, user, req, res, 'sso');
  } catch (err) { next(err); }
});

// GET /api/oauth/config - Return OAuth config for frontend
router.get('/config', (req, res) => {
  res.json({
    google: { enabled: enabled(process.env.GOOGLE_CLIENT_ID), clientId: process.env.GOOGLE_CLIENT_ID || null },
    microsoft: { enabled: enabled(process.env.MICROSOFT_CLIENT_ID) && !!microsoftTenant(), clientId: process.env.MICROSOFT_CLIENT_ID || null, tenantId: microsoftTenant() },
  });
});

module.exports = router;
