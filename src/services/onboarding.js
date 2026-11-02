const { KEY, validateRequirements } = require('./dealCoaching');
const { permits } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const crypto = require('crypto');
const TEMPLATES = [
  { id: 'flexible', name: 'Flexible sales', description: 'Keep stage moves open while your team establishes its process.', requirements: {} },
  { id: 'consultative', name: 'Consultative B2B', description: 'Require a next step for proposals, then budget and decision-maker qualification for negotiation.', requirements: { Proposal: ['nextStep'], Negotiation: ['nextStep', 'budget', 'authority'], 'Closed Won': ['contactId'] } },
];
const fingerprint = value => crypto.createHash('sha256').update(value || '{}').digest('hex');
const ensure = (db, userId) => db.userOnboarding.upsert({ where: { userId }, create: { userId }, update: { userId } });
async function milestone(db, userId, field) {
  if (!userId || !['firstImportAt', 'firstDealAt', 'firstQuoteAt'].includes(field)) return;
  await ensure(db, userId);
  await db.userOnboarding.updateMany({ where: { userId, [field]: null }, data: { [field]: new Date() } });
}
async function status(db, req) {
  const progress = await ensure(db, req.userId);
  const mail = permits(req, 'emails', 'read') && await db.inboundEmailAccount.findFirst({ where: { ownerId: req.userId, active: true, deletedAt: null, oauthRefreshToken: { not: null } }, select: { id: true } });
  const invite = permits(req, 'users', 'full') && await db.userInvite.findFirst({ where: { invitedById: req.userId, status: { in: ['Pending', 'Accepted'] } }, select: { id: true } });
  const steps = [
    { id: 'pipeline', label: 'Set up your pipeline', detail: 'Review the six sales stages and choose stage requirements.', module: 'pipeline', done: !!progress.pipelineReadyAt, available: permits(req, 'deals', 'read') },
    { id: 'email', label: 'Connect your email', detail: 'Connect Google or Microsoft from your mailbox.', module: 'mailbox', done: !!mail, available: permits(req, 'emails', 'edit') },
    { id: 'import', label: 'Import your contacts', detail: 'Download the CSV template, preview your mapping, then import.', module: 'import', done: !!progress.firstImportAt, available: permits(req, 'contacts', 'edit') },
    { id: 'invite', label: 'Invite a teammate', detail: 'Send an invitation from Access Requests.', module: 'accessRequests', done: !!invite, available: permits(req, 'users', 'full') },
    { id: 'deal', label: 'Create your first deal', detail: 'Save a real opportunity with its value and next step.', module: 'deals', done: !!progress.firstDealAt, available: permits(req, 'deals', 'edit') },
  ];
  return { steps, dismissed: !!progress.dismissedAt, analyticsOptOut: progress.analyticsOptOut, complete: steps.filter(s => s.available).every(s => s.done) };
}
async function pipeline(db) {
  const current = await db.setting.findUnique({ where: { key: KEY } });
  return { stages: ['Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'], current: current ? JSON.parse(current.value) : {}, baseHash: fingerprint(current?.value), templates: TEMPLATES };
}
async function choosePipeline(db, req) {
  const { template, baseHash } = req.body;
  if (template !== undefined && !permits(req, 'admin', 'full')) throw Object.assign(new Error('An administrator must apply shared stage requirements'), { status: 403 });
  return db.$transaction(async tx => {
    if (template !== undefined) {
      const selected = TEMPLATES.find(t => t.id === template);
      if (!selected) throw Object.assign(new Error('Choose a pipeline template'), { status: 400 });
      const current = await tx.setting.findUnique({ where: { key: KEY } });
      if (baseHash !== fingerprint(current?.value)) throw Object.assign(new Error('Pipeline settings changed. Review the latest configuration.'), { status: 409 });
      const value = JSON.stringify(validateRequirements(selected.requirements));
      if (current) {
        const changed = await tx.setting.updateMany({ where: { key: KEY, value: current.value }, data: { value } });
        if (!changed.count) throw Object.assign(new Error('Pipeline settings changed. Review them again.'), { status: 409 });
      } else await tx.setting.create({ data: { key: KEY, value } });
      await audit(tx, { action: 'update', module: 'settings', details: `Applied onboarding pipeline template: ${selected.name}`, userId: req.userId });
    }
    await ensure(tx, req.userId);
    await tx.userOnboarding.updateMany({ where: { userId: req.userId, pipelineReadyAt: null }, data: { pipelineReadyAt: new Date() } });
    return { saved: true };
  });
}
async function visit(db, req) {
  const optedOut = req.body.measurement === false || req.get('dnt') === '1' || req.get('sec-gpc') === '1' || process.env.MARKETING_ANALYTICS_ENABLED === 'false';
  await db.$transaction(async tx => {
    // The upsert locks this user's progress row until usage is written, so a
    // concurrent preference change cannot leave usage behind after opting out.
    const progress = await ensure(tx, req.userId);
    if (optedOut) {
      await tx.userOnboarding.update({ where: { userId: req.userId }, data: { analyticsOptOut: true } });
      await tx.userUsageDay.deleteMany({ where: { userId: req.userId } });
    } else if (!progress.analyticsOptOut) {
      const day = new Date().toISOString().slice(0, 10);
      await tx.userUsageDay.upsert({ where: { userId_day: { userId: req.userId, day } }, create: { userId: req.userId, day }, update: { day } });
    }
  });
}
async function activation(db, requests, since) {
  if (process.env.MARKETING_ANALYTICS_ENABLED === 'false') return { accounts: 0, firstImport: 0, firstDeal: 0, firstQuote: 0, repeatUsage: 0 };
  const ids = [...new Set(requests.map(r => r.convertedUserId).filter(Boolean))];
  const people = await db.userOnboarding.findMany({ where: { userId: { in: ids }, analyticsOptOut: false }, include: { user: { select: { usageDays: { where: { createdAt: { gte: since } }, select: { day: true } } } } } });
  const result = { accounts: people.length, firstImport: 0, firstDeal: 0, firstQuote: 0, repeatUsage: 0 };
  for (const p of people) {
    for (const [field, key] of [['firstImportAt', 'firstImport'], ['firstDealAt', 'firstDeal'], ['firstQuoteAt', 'firstQuote']]) if (p[field] && p[field] >= since) result[key]++;
    if (p.user.usageDays.length >= 2) result.repeatUsage++;
  }
  return result;
}
module.exports = { status, milestone, pipeline, choosePipeline, visit, activation, ensure };
