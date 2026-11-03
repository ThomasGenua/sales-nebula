const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const writes = require('./recordWrites');
const { permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { acquireLease, releaseLease } = require('../utils/lease');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const clean = s => String(s || '').trim();
const normalize = s => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const json = value => JSON.parse(JSON.stringify(value));
const fields = {
  accounts: ['name', 'industry', 'website', 'phone', 'description'],
  contacts: ['firstName', 'lastName', 'email', 'phone', 'title', 'description'],
  leads: ['firstName', 'lastName', 'company', 'email', 'phone', 'title', 'source', 'description'],
  deals: ['name', 'value', 'stage', 'closeDate', 'nextStep', 'nextStepDate', 'description', 'currency'],
};
const models = { accounts: 'account', contacts: 'contact', leads: 'lead', deals: 'deal' };
const required = { accounts: ['name'], contacts: ['firstName', 'lastName'], leads: ['firstName', 'lastName', 'company'], deals: ['name', 'stage'] };
const aliases = {
  sourceId: ['id', 'recordid', 'accountid', 'contactid', 'leadid', 'opportunityid', 'dealid', 'hsobjectid'],
  name: ['name', 'accountname', 'companyname', 'opportunityname', 'dealname'],
  value: ['amount', 'value', 'dealamount'], stage: ['stage', 'stagename', 'dealstage'],
  ownerExternalId: ['ownerid', 'hubspotownerid', 'hubspotowner'], ownerEmail: ['owneremail', 'dealowneremail', 'contactowneremail'],
  accountExternalId: ['accountid', 'associatedcompanyid', 'associatedcompanyids', 'companyid'],
  contactExternalId: ['contactid', 'associatedcontactid', 'associatedcontactids'],
  closeDate: ['closedate', 'closingdate'], nextStep: ['nextstep', 'nextaction'],
};
const stages = ['Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
// Explicit aliases keep unknown pipelines visible for correction in the preview.
const stageMap = { prospecting: 'Qualification', qualifiedtobuy: 'Qualification', appointmentscheduled: 'Discovery', needsanalysis: 'Discovery', valueproposition: 'Proposal', iddecisionmakers: 'Discovery', perceptionanalysis: 'Discovery', proposalpricequote: 'Proposal', presentationscheduled: 'Proposal', negotiationreview: 'Negotiation', decisionmakerboughtin: 'Negotiation', contractsent: 'Negotiation', closedwon: 'Closed Won', won: 'Closed Won', closedlost: 'Closed Lost', lost: 'Closed Lost' };
function mapping(module, headers) {
  const keys = ['sourceId', ...fields[module], 'ownerEmail', 'ownerExternalId', ...(['contacts', 'deals'].includes(module) ? ['accountExternalId'] : []), ...(module === 'deals' ? ['contactExternalId'] : [])];
  return Object.fromEntries(keys.map(key => {
    const choices = key === 'sourceId' ? ['sourceid', 'id', 'recordid', 'hsobjectid', module === 'deals' ? 'opportunityid' : module.slice(0, -1) + 'id', ...(module === 'deals' ? ['dealid'] : [])] : [normalize(key), ...(aliases[key] || [])];
    return [key, choices.map(k => headers.find(h => normalize(h) === k)).find(Boolean) || ''];
  }));
}
function problem(module, data) {
  for (const key of required[module]) if (!clean(data[key])) return `${key} is required`;
  if (module === 'deals' && !stages.includes(data.stage)) return 'Choose a supported deal stage';
  if (module === 'deals' && (!Number.isFinite(Number(data.value || 0)) || Number(data.value || 0) < 0)) return 'Deal value must be nonnegative';
  for (const key of ['closeDate', 'nextStepDate']) if (data[key] && !Number.isFinite(Date.parse(data[key]))) return `${key} is not a valid date`;
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return 'Email address is invalid';
  return null;
}
async function stage(db, req, input) {
  if (!['salesforce', 'hubspot'].includes(input.source)) fail('Choose Salesforce or HubSpot');
  if (!clean(input.sourceInstance) || clean(input.sourceInstance).length > 120) fail('Name the source organization so external IDs stay separate');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 4) fail('Choose up to four record files');
  if (!['skip', 'update'].includes(input.duplicatePolicy || 'skip')) fail('Choose a duplicate policy');
  const ownerMap = input.ownerMap || {}, stageOverrides = input.stageMap || {}, rows = [], seen = new Set();
  if ([ownerMap, stageOverrides].some(v => !v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some(s => typeof s !== 'string' || s.length > 320))) fail('Owner and stage mappings must contain text values');
  for (const file of input.files) {
    if (!file || !Object.hasOwn(fields, file.module) || !Array.isArray(file.records)) fail('Unsupported record file');
    if (file.mapping && (typeof file.mapping !== 'object' || Array.isArray(file.mapping) || Object.values(file.mapping).some(v => typeof v !== 'string'))) fail('Choose CSV columns for each mapped field');
    if (!permits(req, file.module, 'edit')) fail('Missing access to ' + file.module, 403);
    const allowed = Object.keys(mapping(file.module, []));
    const map = { ...mapping(file.module, Object.keys(file.records[0] || {})), ...file.mapping };
    if (Object.keys(map).some(k => !allowed.includes(k))) fail('Unknown mapping field');
    for (const raw of file.records) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw).some(v => typeof v !== 'string' || v.length > 20000)) fail('CSV rows must contain text fields shorter than 20,000 characters');
      const data = {};
      for (const key of allowed) if (map[key] && raw[map[key]] != null) data[key] = clean(raw[map[key]]);
      const sourceId = data.sourceId;
      if (!sourceId || sourceId.length > 160) fail('Every row needs a source record ID');
      const unique = file.module + ':' + sourceId;
      if (seen.has(unique)) fail(`Duplicate source ID ${sourceId} in ${file.module}`);
      seen.add(unique); delete data.sourceId;
      if (data.email) data.email = data.email.toLowerCase();
      if (!data.ownerEmail && data.ownerExternalId) data.ownerEmail = clean(ownerMap[data.ownerExternalId]);
      if (file.module === 'deals') data.stage = stageOverrides[data.stage] || stages.find(s => normalize(s) === normalize(data.stage)) || stageMap[normalize(data.stage)] || data.stage;
      const error = data.ownerExternalId && !data.ownerEmail ? 'Map this source owner to a current teammate email' : problem(file.module, data);
      rows.push({ module: file.module, sourceId, position: Object.keys(models).indexOf(file.module) * 100000 + rows.length, data, status: error ? 'Invalid' : 'Pending', error });
    }
  }
  if (!rows.length || rows.length > 50000) fail('Choose 1–50,000 rows per migration');
  return db.migrationBatch.create({ data: { source: input.source, sourceInstance: clean(input.sourceInstance), name: clean(input.name).slice(0, 120) || 'CRM migration', createdById: req.userId, duplicatePolicy: input.duplicatePolicy || 'skip', rows: { createMany: { data: rows } } } });
}
const keyFor = (batch, module, sourceId) => ({ source: batch.source, sourceInstance: batch.sourceInstance, module, sourceId });
async function linked(db, batch, module, sourceId) {
  if (!sourceId) return null;
  const link = await db.migrationLink.findUnique({ where: { source_sourceInstance_module_sourceId: keyFor(batch, module, sourceId) } });
  if (!link || !await db[models[module]].findFirst({ where: { id: link.recordId, deletedAt: null } })) fail(`Import the linked ${module} record ${sourceId} first`);
  return link.recordId;
}
async function applyRow(db, req, batch, row) {
  const after = [];
  await db.$transaction(async tx => {
    const claimed = await tx.migrationRow.updateMany({ where: { id: row.id, status: 'Pending' }, data: { status: 'Applying' } });
    if (!claimed.count) return;
    const data = Object.fromEntries(fields[row.module].filter(k => Object.hasOwn(row.data, k)).map(k => [k, row.data[k]]));
    const invalid = problem(row.module, data); if (invalid) fail(invalid);
    if (row.module === 'deals') {
      data.value = Number(data.value || 0);
      for (const key of ['closeDate', 'nextStepDate']) if (data[key]) data[key] = new Date(data[key]); else delete data[key];
    }
    if (row.data.ownerExternalId && !row.data.ownerEmail) fail('Map the source owner to a current teammate email');
    const owner = row.data.ownerEmail ? await tx.user.findFirst({ where: { email: { equals: row.data.ownerEmail, mode: 'insensitive' }, active: true, isPortalUser: false } }) : req.user;
    if (!owner) fail('Owner email does not match an active teammate');
    data.ownerId = owner.id;
    if (row.data.accountExternalId) data.accountId = await linked(tx, batch, 'accounts', row.data.accountExternalId);
    if (row.data.contactExternalId) data.contactId = await linked(tx, batch, 'contacts', row.data.contactExternalId);
    const external = await tx.migrationLink.findUnique({ where: { source_sourceInstance_module_sourceId: keyFor(batch, row.module, row.sourceId) } });
    const match = row.module === 'contacts' || row.module === 'leads' ? 'email' : 'name';
    const matches = external ? [await tx[models[row.module]].findFirst({ where: await reachableWhere(req, row.module, models[row.module], { id: external.recordId }) })].filter(Boolean) : data[match] ? await tx[models[row.module]].findMany({ where: await reachableWhere(req, row.module, models[row.module], { [match]: { equals: data[match], mode: 'insensitive' } }), take: 2 }) : [];
    if (external && !matches.length) fail('This source record links to a deleted or inaccessible record');
    if (matches.length > 1) fail('Multiple existing records match. Resolve the duplicate before continuing');
    const current = matches[0];
    if (current && !row.data.ownerEmail && !row.data.ownerExternalId) delete data.ownerId;
    if (current && batch.duplicatePolicy === 'skip') {
      await tx.migrationLink.upsert({ where: { source_sourceInstance_module_sourceId: keyFor(batch, row.module, row.sourceId) }, create: { ...keyFor(batch, row.module, row.sourceId), recordId: current.id, batchId: batch.id }, update: {} });
      await tx.migrationRow.update({ where: { id: row.id }, data: { status: 'Skipped', recordId: current.id, error: null } }); return;
    }
    const ctx = { req, userId: req.userId, after, prisma: db, source: 'CRM migration' };
    const result = current ? await writes.updateRecord(tx, row.module, current, data, ctx) : await writes.createRecord(tx, row.module, data, ctx);
    const record = result.record;
    await tx.migrationLink.upsert({ where: { source_sourceInstance_module_sourceId: keyFor(batch, row.module, row.sourceId) }, create: { ...keyFor(batch, row.module, row.sourceId), recordId: record.id, batchId: batch.id }, update: { recordId: record.id } });
    await tx.migrationRow.update({ where: { id: row.id }, data: { status: 'Applied', recordId: record.id, operation: current ? 'update' : 'create', before: current ? json(Object.fromEntries(Object.keys(data).map(k => [k, current[k] ?? null]))) : Prisma.DbNull, afterVersion: record.updatedAt, error: null } });
    if (row.module === 'contacts') await require('./onboarding').milestone(tx, req.userId, 'firstImportAt');
  }, { timeout: 20000, isolationLevel: 'Serializable' });
  await writes.runAfter(after);
}
async function runBatch(raw, id) {
  const lease = await acquireLease(raw, 'migration:' + id, 120000); if (!lease) return;
  try {
    const batch = await raw.migrationBatch.findUnique({ where: { id } }); if (batch?.status !== 'Running') return;
    await require('./revenueActor').asActor(raw, batch.createdById, 'admin', async (db, req) => {
      if (!permits(req, 'admin', 'full')) fail('Migration owner no longer has administrative access', 403);
      const rows = await db.migrationRow.findMany({ where: { batchId: id, status: 'Pending' }, orderBy: { position: 'asc' }, take: 250 });
      const started = Date.now();
      for (const row of rows) {
        if (Date.now() - started > 30000 || (await db.migrationBatch.findUnique({ where: { id } })).status !== 'Running') break;
        try { await applyRow(db, req, batch, row); }
        catch (e) { await db.migrationRow.updateMany({ where: { id: row.id, status: 'Pending' }, data: { status: 'Failed', error: String(e.message).slice(0, 500) } }); }
      }
      if (!await db.migrationRow.count({ where: { batchId: id, status: 'Pending' } })) {
        const failed = await db.migrationRow.count({ where: { batchId: id, status: { in: ['Failed', 'Invalid'] } } });
        await db.migrationBatch.updateMany({ where: { id, status: 'Running' }, data: { status: failed ? 'Needs review' : 'Completed' } });
      }
    });
  } catch (e) { await raw.migrationBatch.update({ where: { id }, data: { status: 'Paused', error: String(e.message).slice(0, 500) } }); }
  finally { await releaseLease(raw, 'migration:' + id, lease); }
}
async function outsideLinks(db, row, created) {
  const field = { accounts: 'accountId', contacts: 'contactId', leads: 'leadId', deals: 'dealId' }[row.module];
  const historyModels = new Set(['DealHistory', 'DealStageHistory']);
  for (const model of Prisma.dmmf.datamodel.models.filter(m => !historyModels.has(m.name) && m.fields.some(f => f.name === field && f.kind !== 'object') && m.fields.some(f => f.name === 'id'))) {
    const delegate = model.name[0].toLowerCase() + model.name.slice(1);
    const where = { [field]: row.recordId, ...(model.fields.some(f => f.name === 'deletedAt') && { deletedAt: null }), id: { notIn: created } };
    if (await db[delegate].findFirst({ where, select: { id: true } })) return `New related ${model.name} records depend on this record`;
  }
  return null;
}
async function undoPreview(db, batch) {
  const rows = await db.migrationRow.findMany({ where: { batchId: batch.id, status: 'Applied' }, orderBy: { position: 'desc' } });
  const created = rows.filter(r => r.operation === 'create').map(r => r.recordId), result = [];
  for (const row of rows) {
    const record = await db[models[row.module]].findFirst({ where: { id: row.recordId, deletedAt: null } });
    let conflict = !record || +record.updatedAt !== +row.afterVersion ? 'Record changed after this migration' : null;
    if (!conflict && row.operation === 'create') conflict = await outsideLinks(db, row, created);
    result.push({ id: row.id, module: row.module, sourceId: row.sourceId, operation: row.operation, conflict, version: record?.updatedAt });
  }
  return { rows: result, hash: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
async function undo(db, req, batch, expectedHash) {
  const lease = await acquireLease(db, 'migration:' + batch.id, 120000); if (!lease) fail('Migration is busy; pause it and retry', 409);
  try {
    const preview = await undoPreview(db, batch);
    if (preview.hash !== expectedHash) fail('Records changed. Preview undo again', 409);
    if (preview.rows.some(r => r.conflict)) fail('Resolve the conflicts before undoing this migration', 409);
    // One transaction makes undo all-or-nothing, including validation failures.
    const after = [];
    await db.$transaction(async tx => {
      const rows = await tx.migrationRow.findMany({ where: { batchId: batch.id, status: 'Applied' }, orderBy: { position: 'desc' } });
      for (const row of rows) {
        const record = await tx[models[row.module]].findFirst({ where: { id: row.recordId, updatedAt: row.afterVersion, deletedAt: null } });
        if (!record) fail('Record changed during undo; preview again', 409);
        const ctx = { req, userId: req.userId, after, prisma: db, source: 'migration undo' };
        if (row.operation === 'create') {
          if (await outsideLinks(tx, row, rows.filter(r => r.operation === 'create').map(r => r.recordId))) fail('A new related record prevents undo', 409);
          await writes.deleteRecord(tx, row.module, record, ctx);
          await tx.migrationLink.deleteMany({ where: { batchId: batch.id, recordId: row.recordId } });
        } else {
          const data = { ...row.before };
          for (const key of ['closeDate', 'nextStepDate']) if (data[key]) data[key] = new Date(data[key]);
          await writes.updateRecord(tx, row.module, record, data, ctx);
        }
        await tx.migrationRow.update({ where: { id: row.id }, data: { status: 'Undone' } });
      }
      await tx.migrationBatch.update({ where: { id: batch.id }, data: { status: 'Undone' } });
    }, { isolationLevel: 'Serializable', timeout: 120000 });
    await writes.runAfter(after);
    return { undone: preview.rows.length };
  } finally { await releaseLease(db, 'migration:' + batch.id, lease); }
}
async function processDue(db) {
  const batches = await db.migrationBatch.findMany({ where: { status: 'Running' }, orderBy: { createdAt: 'asc' }, take: 5 });
  for (const batch of batches) await runBatch(db, batch.id);
}
module.exports = { fields, required, models, stages, mapping, problem, stage, runBatch, undoPreview, undo, processDue };
