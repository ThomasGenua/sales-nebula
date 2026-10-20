const { Router } = require('express');
const { authenticate, permits, requirePermission } = require('../middleware/auth');
const { reachableWhere, canReach } = require('../middleware/access');
const { createRecord, updateRecord, runAfter } = require('../services/recordWrites');
const { KEY, CHECKS, validateRequirements } = require('../services/dealCoaching');
const { audit } = require('../middleware/audit');
const router = Router();
router.use(authenticate);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const dbOf = req => req.app.locals.prisma;
async function rows(req, module, model, where, options = {}) {
  if (!permits(req, module, 'read')) return [];
  return dbOf(req)[model].findMany({ where: await reachableWhere(req, module, model, where), take: 100, ...options });
}
async function record(req, module, model, id, level = 'Read') {
  if (typeof id !== 'string' || !id) fail(400, 'A record ID is required');
  if (!permits(req, module, level === 'Read' ? 'read' : 'edit')) fail(403, 'Insufficient permissions');
  const result = await dbOf(req)[model].findFirst({ where: await reachableWhere(req, module, model, { id }, level) });
  if (!result) fail(404, 'Not found');
  return result;
}
const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

router.get('/workspace', wrap(async (req, res) => {
  const now = new Date(), end = new Date(+now + 7 * 86400000);
  const meetings = await rows(req, 'activities', 'activity', { type: 'Meeting', assignedId: req.userId, date: { gte: now, lt: end }, status: { notIn: ['Completed', 'Cancelled'] } }, { orderBy: { date: 'asc' } });
  // Personal messages stay private even to administrators. A reply sent from
  // another client also resolves the thread once its Sent Items are synced.
  const messages = permits(req, 'emails', 'read') ? await dbOf(req).inboundEmailMessage.findMany({
    where: { deletedAt: null, direction: 'inbound', repliedAt: null, isAutomated: false,
      status: { notIn: ['Ignored', 'Failed', 'Duplicate'] }, account: { is: { ownerId: req.userId, deletedAt: null } } },
    orderBy: { receivedAt: 'desc' }, take: 100,
    select: { id: true, accountId: true, threadKey: true, subject: true, receivedAt: true, fromEmail: true },
  }) : [];
  const unanswered = [];
  const seen = new Set();
  for (const message of messages) {
    const key = `${message.accountId}:${message.threadKey || message.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reply = message.threadKey && await dbOf(req).inboundEmailMessage.findFirst({ where: {
      accountId: message.accountId, threadKey: message.threadKey, direction: 'outbound', deletedAt: null, receivedAt: { gte: message.receivedAt },
    }, select: { id: true } });
    if (!reply) unanswered.push(message);
  }
  const calendar = require('./calendar');
  const events = permits(req, 'activities', 'read') ? await calendar.expandEventsInRange(dbOf(req), { AND: [calendar.participantWhere(req.userId), { isCancelled: false }] }, now, end) : [];
  res.json({ meetings, events: events.map(e => ({ id: e.id, title: e.title, startAt: e.startAt, endAt: e.endAt })), unanswered, limit: 100 });
}));

router.get('/accounts/:id', requirePermission('accounts', 'read'), wrap(async (req, res) => {
  const account = await record(req, 'accounts', 'account', req.params.id);
  const contacts = await rows(req, 'contacts', 'contact', { accountId: account.id }, { select: { id: true, firstName: true, lastName: true }, take: 5000 });
  const deals = await rows(req, 'deals', 'deal', { accountId: account.id }, { select: { id: true, name: true, stage: true, value: true, currency: true, createdAt: true }, take: 5000 });
  const contactIds = contacts.map(r => r.id), dealIds = deals.map(r => r.id);
  const related = { OR: [{ accountId: account.id }, { contactId: { in: contactIds } }, { dealId: { in: dealIds } }] };
  const items = [];
  const sources = [
    ['activities', 'activity', related, 'subject'],
    ['emails', 'email', { OR: [{ contactId: { in: contactIds } }, { dealId: { in: dealIds } }] }, 'subject'],
    ['quotes', 'quote', related, 'name'],
    ['orders', 'order', { accountId: account.id }, 'orderNumber'],
    ['cases', 'case', related, 'subject'],
    ['contracts', 'contract', { accountId: account.id }, 'name'],
    ['invoices', 'invoice', { accountId: account.id }, 'invoiceNumber'],
  ];
  for (const [module, model, where, title] of sources) {
    const records = await rows(req, module, model, where, { orderBy: { createdAt: 'desc' }, select: { id: true, [title]: true, status: true, createdAt: true } });
    items.push(...records.map(r => ({ id: r.id, title: r[title] || module, status: r.status, date: r.createdAt, module })));
  }
  items.push(...deals.map(d => ({ id: d.id, title: d.name, status: d.stage, date: d.createdAt, module: 'deals' })));
  if (permits(req, 'activities', 'read')) {
    const events = await dbOf(req).calendarEvent.findMany({ where: { AND: [
      require('./calendar').visibleEventWhere(req.user),
      { deletedAt: null, OR: [{ accountId: account.id }, { contactId: { in: contactIds } }, { dealId: { in: dealIds } }] },
    ] }, orderBy: { startAt: 'desc' }, take: 100, select: { id: true, title: true, startAt: true, status: true } });
    items.push(...events.map(e => ({ id: e.id, title: e.title, date: e.startAt, status: e.status, module: 'calendar' })));
  }
  items.sort((a, b) => +b.date - +a.date || a.id.localeCompare(b.id));
  res.json({ account: { id: account.id, name: account.name }, contacts, deals, timeline: items.slice(0, 200), limit: 200,
    coverage: 'Newest 100 entries per related module, up to 5,000 visible contacts and deals.' });
}));

router.get('/requirements', requirePermission('deals', 'read'), wrap(async (req, res) => {
  const saved = await dbOf(req).setting.findUnique({ where: { key: KEY } });
  res.json({ checks: CHECKS, stages: saved ? JSON.parse(saved.value) : {} });
}));
router.post('/accounts/:id/expansion', requirePermission('deals', 'edit'), wrap(async (req, res) => {
  const account = await record(req, 'accounts', 'account', req.params.id);
  const value = Number(req.body.value), closeDate = new Date(req.body.closeDate);
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(+closeDate)) fail(400, 'Provide a non-negative value and valid close date');
  const result = await createRecord(dbOf(req), 'deals', { name: `${account.name} — Expansion`, type: 'Expansion', stage: 'Qualification',
    accountId: account.id, value, closeDate, currency: req.body.currency, ownerId: req.userId },
  { req, userId: req.userId, source: 'account expansion' });
  res.status(201).json(result.record);
}));
router.put('/requirements', requirePermission('admin', 'full'), wrap(async (req, res) => {
  const value = JSON.stringify(validateRequirements(req.body));
  await dbOf(req).setting.upsert({ where: { key: KEY }, create: { key: KEY, value, category: 'sales', updatedById: req.userId }, update: { value, updatedById: req.userId } });
  await audit(dbOf(req), { action: 'update', module: 'settings', details: 'Updated deal stage requirements', userId: req.userId });
  res.json({ saved: true });
}));

router.get('/pipeline-changes', requirePermission('deals', 'read'), wrap(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 30 * 86400000);
  if (!Number.isFinite(+since)) fail(400, 'Invalid start date');
  const where = { changedAt: { gte: since }, deal: { is: await reachableWhere(req, 'deals', 'deal') } };
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const [changes, total] = await Promise.all([
    dbOf(req).dealHistory.findMany({ where, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], take: 50, skip: (page - 1) * 50, include: { deal: { select: { id: true, name: true, currency: true } } } }),
    dbOf(req).dealHistory.count({ where }),
  ]);
  const ownerIds = [...new Set(changes.filter(c => c.field === 'ownerId').flatMap(c => [c.oldValue, c.newValue]).filter(Boolean))];
  const owners = permits(req, 'users', 'read') && ownerIds.length ? await dbOf(req).user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const names = new Map(owners.map(u => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ')]));
  res.json({ data: changes.map(c => ({ ...c, oldDisplay: c.field === 'ownerId' ? names.get(c.oldValue) || (c.oldValue ? 'Team member' : 'Unassigned') : c.oldValue,
    newDisplay: c.field === 'ownerId' ? names.get(c.newValue) || (c.newValue ? 'Team member' : 'Unassigned') : c.newValue,
    slipped: c.field === 'closeDate' && !!c.oldValue && !!c.newValue && +new Date(c.newValue) > +new Date(c.oldValue) })), total, page });
}));

router.get('/renewals', requirePermission('contracts', 'read'), wrap(async (req, res) => {
  const days = Math.max(1, Math.min(730, Number(req.query.days) || 90));
  const contracts = await rows(req, 'contracts', 'contract', { endDate: { lte: new Date(Date.now() + days * 86400000) }, status: { in: ['Activated', 'Expired'] } }, { orderBy: { endDate: 'asc' } });
  const opportunities = await rows(req, 'deals', 'deal', { renewalContractId: { in: contracts.map(c => c.id) } }, { select: { id: true, name: true, stage: true, renewalContractId: true } });
  res.json({ data: contracts.map(c => ({ id: c.id, name: c.name || c.contractNumber, endDate: c.endDate, value: c.value ?? c.totalValue,
    accountId: c.accountId, daysRemaining: Math.ceil((+c.endDate - Date.now()) / 86400000), opportunity: opportunities.find(d => d.renewalContractId === c.id) || null })), limit: 100 });
}));
router.post('/renewals/:id/opportunity', requirePermission('deals', 'edit'), wrap(async (req, res) => {
  const contract = await record(req, 'contracts', 'contract', req.params.id);
  if (!['Activated', 'Expired'].includes(contract.status)) fail(400, 'Only activated or expired contracts can enter the renewal pipeline');
  const value = req.body.value === undefined ? contract.value ?? contract.totalValue : Number(req.body.value);
  if (!Number.isFinite(value) || value < 0) fail(400, 'Value must be a non-negative number');
  const db = dbOf(req), after = [];
  try {
    const created = await db.$transaction(async tx => createRecord(tx, 'deals', {
      name: `${contract.name || contract.contractNumber} — Renewal`, accountId: contract.accountId,
      value, closeDate: contract.endDate, type: 'Renewal', stage: 'Qualification', ownerId: req.userId,
      renewalContractId: contract.id, nextStep: 'Review renewal and expansion requirements',
      nextStepDate: new Date(), currency: req.body.currency || undefined,
    }, { req, userId: req.userId, source: 'renewal opportunity', after, prisma: db }));
    await runAfter(after); res.status(201).json(created.record);
  } catch (e) { if (e.code === 'P2002') fail(409, 'A renewal opportunity already exists for this contract'); throw e; }
}));
router.post('/renewals/:id/reminder', requirePermission('activities', 'edit'), wrap(async (req, res) => {
  const contract = await record(req, 'contracts', 'contract', req.params.id);
  const dueDate = new Date(req.body.dueDate);
  if (!Number.isFinite(+dueDate)) fail(400, 'A valid reminder date is required');
  const created = await createRecord(dbOf(req), 'activities', { type: 'Task', subject: `Renewal: ${contract.name || contract.contractNumber}`,
    accountId: contract.accountId, dueDate, ownerId: req.userId, assignedId: req.userId, status: 'Scheduled' },
  { req, userId: req.userId, source: 'renewal reminder' });
  res.status(201).json(created.record);
}));

const QUALITY = { contacts: ['contact', ['email', 'phone']], leads: ['lead', ['email', 'company']], accounts: ['account', ['industry', 'website']] };
router.get('/quality/:module', wrap(async (req, res) => {
  const { module } = req.params, spec = QUALITY[module];
  if (!spec) fail(400, 'Unsupported module');
  if (!permits(req, module, 'read')) fail(403, 'Insufficient permissions');
  const page = Math.max(1, parseInt(req.query.page) || 1), [model, fields] = spec;
  const where = await reachableWhere(req, module, model);
  const [data, total] = await Promise.all([dbOf(req)[model].findMany({ where, orderBy: { id: 'asc' }, skip: (page - 1) * 50, take: 50 }), dbOf(req)[model].count({ where })]);
  const result = [];
  for (const r of data) {
    const key = module === 'accounts' ? 'name' : 'email';
    const duplicates = r[key] ? await rows(req, module, model, { id: { not: r.id }, [key]: { equals: r[key], mode: 'insensitive' } }, { select: { id: true }, take: 10 }) : [];
    result.push({ id: r.id, name: r.name || [r.firstName, r.lastName].filter(Boolean).join(' '), updatedAt: r.updatedAt,
      missing: fields.filter(f => !String(r[f] || '').trim()), stale: +r.updatedAt < Date.now() - 90 * 86400000, duplicates });
  }
  res.json({ data: result, total, page, fields });
}));
router.post('/quality/:module/bulk', wrap(async (req, res) => {
  const { module } = req.params, spec = QUALITY[module];
  if (!spec || !permits(req, module, 'edit')) fail(403, 'Insufficient permissions');
  const { ids, field, value } = req.body;
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string') || !spec[1].includes(field) || typeof value !== 'string' || value.length > 500) fail(400, 'Choose up to 50 records and a supported field');
  const outcomes = [];
  for (const id of [...new Set(ids)]) {
    try { const row = await record(req, module, spec[0], id, 'Edit'); await updateRecord(dbOf(req), module, row, { [field]: value }, { req, userId: req.userId, source: 'quality cleanup' }); outcomes.push({ id, saved: true }); }
    catch (e) { if ((e.status || 500) >= 500) throw e; outcomes.push({ id, saved: false, error: e.message }); }
  }
  res.json({ outcomes });
}));
router.post('/quality/:module/merge-preview', wrap(async (req, res) => {
  const spec = QUALITY[req.params.module];
  if (!spec) fail(400, 'Unsupported module');
  const master = await record(req, req.params.module, spec[0], req.body.masterId);
  const source = await record(req, req.params.module, spec[0], req.body.sourceId);
  if (master.id === source.id) fail(400, 'Choose two different records');
  const fields = [...new Set(['name', 'firstName', 'lastName', ...spec[1]])].filter(f => f in master);
  res.json({ masterId: master.id, sourceId: source.id, fields: fields.map(field => ({ field, master: master[field], source: source[field] })) });
}));
router.get('/integrations', wrap(async (req, res) => {
  const db = dbOf(req);
  const mailboxes = permits(req, 'emails', 'read') ? await db.inboundEmailAccount.findMany({ where: { ownerId: req.userId, deletedAt: null },
    select: { id: true, name: true, provider: true, status: true, lastPolledAt: true, lastError: true, calendarEnabled: true, calendarLastSyncedAt: true, calendarError: true } }) : [];
  const webhooks = permits(req, 'settings', 'read') ? await db.webhook.findMany({ select: { id: true, name: true, active: true,
    logs: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, event: true, success: true, statusCode: true, attempts: true, createdAt: true } } } }) : [];
  const indexing = permits(req, 'admin', 'read') ? { pending: await db.searchIndexQueue.count(), failed: await db.searchIndexQueue.count({ where: { attempts: { gte: 5 } } }) } : null;
  const reconciliation = permits(req, 'emails', 'read') ? {
    unlinkedMessages: await db.inboundEmailMessage.count({ where: { deletedAt: null, contactId: null, dealId: null, account: { is: { ownerId: req.userId, deletedAt: null } } } }),
    failedMessages: await db.inboundEmailMessage.count({ where: { deletedAt: null, status: 'Failed', account: { is: { ownerId: req.userId, deletedAt: null } } } }),
  } : null;
  res.json({ mailboxes, webhooks, indexing, reconciliation, note: 'Mailbox status reflects the last sync. Generic integration configurations do not implement a sync connector.' });
}));
router.post('/webhooks/:id/retry/:logId', requirePermission('settings', 'full'), wrap(async (req, res) => {
  const db = dbOf(req), webhook = await db.webhook.findUnique({ where: { id: req.params.id } });
  const log = await db.webhookLog.findFirst({ where: { id: req.params.logId, webhookId: req.params.id, success: false } });
  if (!webhook || !log) fail(404, 'Failed delivery not found');
  if (!webhook.active) fail(409, 'Enable the webhook before retrying');
  require('../services/webhooks').sendToWebhook(db, webhook, log.event, log.payload);
  await audit(db, { action: 'update', module: 'settings', recordId: webhook.id, details: `Requested retry of delivery ${log.id}`, userId: req.userId });
  res.status(202).json({ queued: true });
}));
module.exports = router;
