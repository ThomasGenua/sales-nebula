const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { isAdmin } = require('../middleware/rowSecurity');
const { appUrl } = require('../utils/mail');
const CORE = 'urn:ietf:params:scim:schemas:core:2.0:User', LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const fail = (detail, status = 400, scimType = 'invalidValue') => { throw Object.assign(new Error(detail), { status, scimType }); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
function fields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Expected a SCIM user');
  if (body.roles?.length || body.groups?.length || body.password) fail('Roles, groups and passwords are managed by the application', 400, 'mutability');
  const email = typeof body.userName === 'string' ? body.userName.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail('userName must be an email address');
  const firstName = body.name?.givenName ?? email.split('@')[0], lastName = body.name?.familyName ?? '';
  if ([firstName, lastName].some(v => typeof v !== 'string' || v.length > 150)) fail('Name fields must be strings shorter than 150 characters');
  const active = body.active == null ? true : body.active;
  if (typeof active !== 'boolean') fail('active must be a boolean');
  if (body.externalId != null && (typeof body.externalId !== 'string' || !body.externalId.trim() || body.externalId.length > 200)) fail('externalId must be a nonempty string shorter than 200 characters');
  if (body.emails != null) {
    if (!Array.isArray(body.emails) || body.emails.some(e => !e || typeof e.value !== 'string')) fail('emails must contain email values');
    const primary = body.emails.find(e => e.primary) || body.emails.find(e => e.type === 'work') || body.emails[0];
    if (primary && primary.value.trim().toLowerCase() !== email) fail('The primary email must match userName');
  }
  return { email, firstName: firstName.trim(), lastName: lastName.trim(), active, externalId: body.externalId?.trim() || null };
}
function resource(row) {
  const u = row.user;
  return { schemas: [CORE], id: u.id, ...(row.externalId && { externalId: row.externalId }), userName: u.email, active: u.active, name: { givenName: u.firstName, familyName: u.lastName }, displayName: [u.firstName, u.lastName].filter(Boolean).join(' '), emails: [{ value: u.email, type: 'work', primary: true }], meta: { resourceType: 'User', created: row.createdAt, lastModified: row.updatedAt, location: appUrl('/api/scim/v2/Users/' + u.id) } };
}
function patch(current, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 50) fail('Provide 1–50 patch operations');
  const body = { userName: current.user.email, name: { givenName: current.user.firstName, familyName: current.user.lastName }, active: current.user.active, externalId: current.externalId };
  for (const op of operations) {
    if (!op || !['add', 'replace', 'remove'].includes(String(op.op).toLowerCase())) fail('Unsupported patch operation', 400, 'invalidSyntax');
    const remove = op.op.toLowerCase() === 'remove';
    if (!op.path) {
      if (remove || !op.value || typeof op.value !== 'object' || Array.isArray(op.value)) fail('Patch needs a path or a user object');
      for (const [key, value] of Object.entries(op.value)) {
        if (!['userName', 'active', 'name', 'emails', 'externalId', 'schemas', 'displayName'].includes(key)) fail('Unsupported attribute: ' + key, 400, 'invalidPath');
        if (key === 'name') body.name = { ...body.name, ...value }; else body[key] = value;
      }
    } else {
      const p = op.path.replace(CORE + ':', '');
      if (['name.givenName', 'name.familyName'].includes(p)) body.name[p.split('.')[1]] = remove ? '' : op.value;
      else if (['userName', 'active', 'externalId', 'emails', 'name'].includes(p)) {
        if (remove && ['userName', 'active'].includes(p)) fail('Cannot remove required attributes', 400, 'mutability');
        body[p] = remove ? (p === 'emails' ? [] : p === 'name' ? {} : null) : op.value;
      } else if (/^emails(?:\[type eq "work"\])?\.value$/i.test(p)) {
        if (remove) body.emails = []; else body.emails = [{ value: op.value, type: 'work', primary: true }];
      } else fail('Unsupported patch path: ' + p, 400, 'invalidPath');
    }
  }
  return fields(body);
}
async function revoke(tx, userId) {
  await tx.apiKey.updateMany({ where: { createdById: userId }, data: { active: false } });
  await tx.oAuthToken.deleteMany({ where: { userId } });
  await tx.oAuthAuthorizationCode.deleteMany({ where: { userId } });
  const accounts = await tx.inboundEmailAccount.findMany({ where: { ownerId: userId }, select: { id: true } });
  await tx.mailboxSubscription.updateMany({ where: { accountId: { in: accounts.map(a => a.id) } }, data: { enabled: false, pendingAt: null } });
  await tx.inboundEmailAccount.updateMany({ where: { ownerId: userId }, data: { active: false, oauthAccessToken: null, oauthRefreshToken: null, oauthExpiresAt: null, calendarEnabled: false, status: 'Disabled' } });
}
module.exports = function scimRouter(db) {
  const router = Router();
  router.use((req, res, next) => {
    res.type('application/scim+json'); res.set('Cache-Control', 'no-store');
    const configured = process.env.SCIM_BEARER_TOKEN || '', token = /^Bearer (\S+)$/i.exec(req.get('authorization') || '')?.[1] || '';
    if (configured.length < 32) return next(Object.assign(new Error('SCIM is not configured'), { status: 503 }));
    if (!token || !crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(), crypto.createHash('sha256').update(configured).digest())) return next(Object.assign(new Error('Invalid provisioning token'), { status: 401 }));
    next();
  });
  router.get('/ServiceProviderConfig', (req, res) => res.json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 500 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false }, authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Deployment-managed SCIM provisioning token', primary: true }] }));
  const userType = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: CORE };
  router.get('/ResourceTypes', (req, res) => res.json({ schemas: [LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [userType] }));
  router.get('/ResourceTypes/User', (req, res) => res.json(userType));
  const attribute = (name, type, required = false, multiValued = false) => ({ name, type, multiValued, required, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: name === 'userName' ? 'server' : 'none' });
  const schema = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'], id: CORE, name: 'User', attributes: [attribute('userName', 'string', true), attribute('active', 'boolean'), attribute('externalId', 'string'), { ...attribute('name', 'complex'), subAttributes: [attribute('givenName', 'string'), attribute('familyName', 'string')] }, { ...attribute('emails', 'complex', false, true), subAttributes: [attribute('value', 'string'), attribute('type', 'string'), attribute('primary', 'boolean')] }] };
  router.get('/Schemas', (req, res) => res.json({ schemas: [LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [schema] }));
  router.get('/Schemas/:id', (req, res) => req.params.id === CORE ? res.json(schema) : res.status(404).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'Schema not found' }));
  router.get('/Users', wrap(async (req, res) => {
    let where = { deletedAt: null };
    if (req.query.filter) {
      const match = /^(userName|externalId) eq ("(?:[^"\\]|\\.)*")$/i.exec(req.query.filter);
      if (!match) fail('Supported filters: userName eq "email" or externalId eq "id"', 400, 'invalidFilter');
      let value; try { value = JSON.parse(match[2]); } catch { fail('Invalid filter string', 400, 'invalidFilter'); }
      if (match[1].toLowerCase() === 'username') where.user = { email: { equals: value, mode: 'insensitive' } }; else where.externalId = value;
    }
    const startIndex = Math.max(1, Math.floor(Number(req.query.startIndex) || 1)), count = req.query.count == null ? 100 : Math.min(500, Math.max(0, Math.floor(Number(req.query.count) || 0)));
    const [totalResults, rows] = await Promise.all([db.scimIdentity.count({ where }), db.scimIdentity.findMany({ where, include: { user: true }, orderBy: { userId: 'asc' }, skip: startIndex - 1, take: count })]);
    res.json({ schemas: [LIST], totalResults, startIndex, itemsPerPage: rows.length, Resources: rows.map(resource) });
  }));
  router.post('/Users', wrap(async (req, res) => {
    const data = fields(req.body), role = await db.role.findFirst({ where: { name: process.env.SCIM_DEFAULT_ROLE || '' }, include: { permissions: true } });
    if (!role || isAdmin({ role }) || role.permissions.some(p => ['admin', 'users', 'roles'].includes(p.module) && ['edit', 'full'].includes(p.level))) fail('Configure SCIM_DEFAULT_ROLE as a role without user or administrative privileges', 503);
    const password = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12);
    const row = await db.$transaction(async tx => {
      const existing = await tx.user.findFirst({ where: { email: { equals: data.email, mode: 'insensitive' } } });
      if (existing) fail('This email already belongs to an account. Provision a new email or manage the existing SCIM user.', 409, 'uniqueness');
      const { externalId, ...profile } = data;
      const user = await tx.user.create({ data: { ...profile, roleId: role.id, password } });
      const created = await tx.scimIdentity.create({ data: { userId: user.id, externalId }, include: { user: true } });
      await tx.auditLog.create({ data: { action: 'create', module: 'users', recordId: user.id, details: 'SCIM provisioned a team account' } }); return created;
    }, { isolationLevel: 'Serializable' });
    res.location(appUrl('/api/scim/v2/Users/' + row.userId)).status(201).json(resource(row));
  }));
  router.param('id', async (req, res, next, id) => {
    try { req.scimUser = await db.scimIdentity.findFirst({ where: { userId: id, deletedAt: null }, include: { user: { include: { role: { include: { permissions: true } } } } } }); if (!req.scimUser) fail('User not found', 404); next(); } catch (e) { next(e); }
  });
  router.get('/Users/:id', (req, res) => res.json(resource(req.scimUser)));
  async function update(req, res, data, deleted = false) {
    const row = await db.$transaction(async tx => {
      const current = await tx.scimIdentity.findFirst({ where: { userId: req.params.id, deletedAt: null }, include: { user: { include: { role: { include: { permissions: true } } } } } });
      if (!current) fail('User not found', 404);
      if (isAdmin(current.user) || current.user.role.permissions.some(p => ['admin', 'users', 'roles'].includes(p.module) && ['edit', 'full'].includes(p.level))) fail('Administrative accounts cannot be changed by SCIM', 403, 'mutability');
      if (current.updatedAt.getTime() !== req.scimUser.updatedAt.getTime()) fail('User changed during provisioning. Read the user and retry.', 409);
      const collision = await tx.user.findFirst({ where: { email: { equals: data.email, mode: 'insensitive' }, NOT: { id: current.userId } } });
      if (collision) fail('userName is already in use', 409, 'uniqueness');
      const { externalId, ...profile } = data;
      await tx.user.update({ where: { id: current.userId }, data: { ...profile, ...((!data.active || data.email !== current.user.email) && { sessionVersion: { increment: 1 } }) } });
      if (!data.active || data.email !== current.user.email) await revoke(tx, current.userId);
      const result = await tx.scimIdentity.update({ where: { userId: current.userId }, data: { externalId, ...(deleted && { deletedAt: new Date() }) }, include: { user: true } });
      await tx.auditLog.create({ data: { action: 'update', module: 'users', recordId: current.userId, details: deleted ? 'SCIM removed and deactivated account' : data.active ? 'SCIM updated account' : 'SCIM deactivated account and revoked access' } }); return result;
    }, { isolationLevel: 'Serializable' });
    if (!data.active || data.email !== req.scimUser.user.email) require('../services/websocket').disconnectUser(row.userId);
    if (deleted) return res.status(204).end(); res.json(resource(row));
  }
  router.put('/Users/:id', wrap(async (req, res) => update(req, res, fields(req.body))));
  router.patch('/Users/:id', wrap(async (req, res) => update(req, res, patch(req.scimUser, req.body.Operations))));
  router.delete('/Users/:id', wrap(async (req, res) => update(req, res, { email: req.scimUser.user.email, firstName: req.scimUser.user.firstName, lastName: req.scimUser.user.lastName, active: false, externalId: req.scimUser.externalId }, true)));
  router.use((err, req, res, next) => res.status(err.code === 'P2002' ? 409 : err.code === 'P2034' ? 409 : err.status || 500).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(err.code === 'P2002' || err.code === 'P2034' ? 409 : err.status || 500), ...(err.code === 'P2002' ? { scimType: 'uniqueness' } : err.scimType ? { scimType: err.scimType } : {}), detail: err.code === 'P2002' ? 'A user with this external ID or email already exists' : err.code === 'P2034' ? 'Concurrent provisioning update. Read the user and retry.' : err.status ? err.message : 'Provisioning failed' }));
  return router;
};
module.exports.fields = fields;
module.exports.patch = patch;
