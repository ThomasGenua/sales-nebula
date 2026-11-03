const router = require('express').Router();
const service = require('../services/enterpriseIdentity');
const { authenticate, requirePermission } = require('../middleware/auth');
const { limiters } = require('../middleware/rateLimit');
const { appUrl } = require('../utils/mail');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/config', (req, res) => res.json(service.config()));
router.post('/start/:provider', limiters.auth, wrap(async (req, res) => res.json(await service.start(req.app.locals.prisma, req, res))));
router.post('/callback', limiters.auth, wrap(async (req, res) => service.callback(req.app.locals.prisma, req, res)));
router.post('/saml/acs', limiters.auth, wrap(async (req, res) => service.samlAcs(req.app.locals.prisma, req, res)));
router.get('/saml/metadata', wrap(async (req, res) => {
  if (!service.config().saml.enabled) return res.status(503).json({ error: 'SAML is not configured' });
  res.type('application/samlmetadata+xml').send(service.saml(req.app.locals.prisma).generateServiceProviderMetadata(null, process.env.SAML_SP_CERT?.replace(/\\n/g, '\n') || null));
}));
router.get('/status', authenticate, requirePermission('admin', 'full'), wrap(async (req, res) => res.json({ providers: service.config(), required: process.env.ENTERPRISE_SSO_REQUIRED === 'true', domains: String(process.env.ENTERPRISE_EMAIL_DOMAINS || '').split(',').filter(Boolean), oidcCallback: appUrl('/oauth/callback?enterprise=oidc'), samlAcs: appUrl('/api/enterprise/saml/acs'), samlMetadata: appUrl('/api/enterprise/saml/metadata'), scimBase: appUrl('/api/scim/v2'), scimConfigured: (process.env.SCIM_BEARER_TOKEN || '').length >= 32 && !!process.env.SCIM_DEFAULT_ROLE, defaultRole: process.env.SCIM_DEFAULT_ROLE || null, provisionedUsers: await req.app.locals.prisma.scimIdentity.count() })));
module.exports = router;
