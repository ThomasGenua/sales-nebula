/**
 * Features this install does not have say so. Each of these endpoints
 * answered as if it had done its work: a flow run "Completed" with nothing
 * run, a deployment "Completed" by a timer, an app "Active" with nothing
 * installed, an IP rule saved that nothing checks. They now answer 501 with a
 * code naming the feature, and change nothing.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestContact, createTestLead, createTestCase, createTestDeal, authHeader } = require('./setup');

let app, prisma, admin;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  admin = await createTestUser({ email: 'admin@unavailable.test' });
});

const call = (method, path, body = {}) => request(app)[method](path).set(authHeader(admin.token)).send(body);
/** A 501 naming the feature, and saying nothing was done. */
const refused = (res, code) => {
  expect([res.status, res.body.code]).toEqual([501, code]);
  expect(res.body.error).toEqual(expect.any(String));
};

describe('flows', () => {
  test('are not run, tested, activated or published', async () => {
    const flow = await prisma.flowDefinition.create({ data: { name: 'Welcome', canvas: { nodes: [{ id: 'a', type: 'RecordCreate' }] }, createdById: admin.user.id } });

    for (const action of ['run', 'test', 'activate', 'publish']) refused(await call('post', `/api/flows/${flow.id}/${action}`), 'FLOWS_UNAVAILABLE');

    const after = await prisma.flowDefinition.findUnique({ where: { id: flow.id } });
    expect(after.status).toBe(flow.status);
    expect(await prisma.flowRun.count()).toBe(0);
    expect(await prisma.flowVersion.count({ where: { flowId: flow.id, publishedAt: { not: null } } })).toBe(0);
  });
});

describe('sandboxes', () => {
  test('are not created, deployed to, imported into, rolled back or compared', async () => {
    refused(await call('post', '/api/environments', { name: 'Staging', type: 'Sandbox' }), 'SANDBOXES_UNAVAILABLE');
    expect(await prisma.environment.count()).toBe(0);

    const [a, b] = await Promise.all(['A', 'B'].map(name => prisma.environment.create({ data: { name, createdById: admin.user.id } })));
    refused(await call('post', `/api/environments/${a.id}/deploy`, { components: ['x'] }), 'SANDBOXES_UNAVAILABLE');
    refused(await call('post', `/api/environments/${a.id}/rollback`, { deploymentId: 'x' }), 'SANDBOXES_UNAVAILABLE');
    refused(await call('post', '/api/environments/change-sets', { name: 'cs', components: [] }), 'SANDBOXES_UNAVAILABLE');
    refused(await call('post', '/api/environments/metadata/import', { metadata: {} }), 'SANDBOXES_UNAVAILABLE');
    refused(await call('get', `/api/environments/${a.id}/compare?targetId=${b.id}`), 'SANDBOXES_UNAVAILABLE');
    expect(await prisma.deployment.count()).toBe(0);

    // What does work still answers: the list, and the metadata export.
    expect((await call('get', '/api/environments')).body.map(e => e.name).sort()).toEqual(['A', 'B']);
    expect((await call('get', '/api/environments/metadata/export')).status).toBe(200);
  });
});

describe('AI agents', () => {
  test('are not run, activated or trained, and no run is recorded', async () => {
    const agent = await prisma.aiAgent.create({ data: { name: 'SDR', type: 'SDR', config: {}, active: true, createdById: admin.user.id } });
    await createTestLead({ status: 'New' });

    refused(await call('post', `/api/ai-agents/${agent.id}/run`, { input: {} }), 'AI_AGENTS_UNAVAILABLE');
    refused(await call('post', `/api/ai-agents/${agent.id}/activate`), 'AI_AGENTS_UNAVAILABLE');
    refused(await call('put', `/api/ai-agents/${agent.id}/training`, { trainingData: { a: 1 } }), 'AI_AGENTS_UNAVAILABLE');

    expect(await prisma.aiAgentRun.count()).toBe(0);
    const after = await prisma.aiAgent.findUnique({ where: { id: agent.id } });
    expect([after.runCount, after.lastTrainedAt]).toEqual([agent.runCount, null]);
  });
});

describe('custom code', () => {
  test('is not activated or scheduled; its syntax check says it never runs', async () => {
    const script = await prisma.customCode.create({ data: { name: 'Tidy', code: 'return 1;' } });

    refused(await call('post', `/api/custom-code/${script.id}/activate`), 'CUSTOM_CODE_UNAVAILABLE');
    refused(await call('post', `/api/custom-code/${script.id}/schedule`, { cron: '* * * * *' }), 'CUSTOM_CODE_UNAVAILABLE');
    const after = await prisma.customCode.findUnique({ where: { id: script.id } });
    expect([after.active, after.schedule]).toEqual([false, null]);

    const checked = await call('post', `/api/custom-code/${script.id}/test`);
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ success: true, message: expect.stringContaining('custom code never runs') });
  });
});

describe('the marketplace', () => {
  test('installs nothing and counts no install', async () => {
    const listing = await prisma.appListing.create({ data: { name: 'Mailer', slug: 'mailer', author: 'Acme' } });

    refused(await call('post', `/api/marketplace/${listing.id}/install`), 'APP_INSTALL_UNAVAILABLE');

    expect(await prisma.installedApp.count()).toBe(0);
    expect((await prisma.appListing.findUnique({ where: { id: listing.id } })).installCount).toBe(listing.installCount);
  });
});

describe('calling', () => {
  test('the dialer says it is unavailable and files no call', async () => {
    const status = await call('get', '/api/conversation-intelligence/dialer/status');
    expect(status.body).toMatchObject({ status: 'unavailable', features: [] });

    refused(await call('post', '/api/conversation-intelligence/dialer/call', { phone: '+15550100' }), 'DIALER_UNAVAILABLE');
    expect(await prisma.callRecording.count()).toBe(0);
  });

  test('call analysis says it is keyword matching', async () => {
    const res = await call('post', '/api/conversation-intelligence/analyze', { transcript: 'We talked about pricing and next steps. Great.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ method: 'keyword matching', detectedTopics: ['pricing', 'next steps'] });
  });
});

describe('mobile', () => {
  test('says push and biometrics are off, sends no push and resolves no conflict', async () => {
    expect((await call('get', '/api/mobile/config')).body.features).toMatchObject({ offlineSync: true, pushNotifications: false, biometricAuth: false });
    refused(await call('post', '/api/mobile/push', { title: 'Hi' }), 'PUSH_UNAVAILABLE');
    refused(await call('post', '/api/mobile/sync/resolve', { conflicts: [{ id: 'x', strategy: 'client_wins' }] }), 'CONFLICT_RESOLUTION_UNAVAILABLE');
  });
});

describe('macros', () => {
  test('report the actions they cannot carry out, and are not scheduled', async () => {
    const kase = await createTestCase({ status: 'New' });
    const macro = await prisma.macro.create({
      data: { name: 'Close and thank', module: 'cases', active: true, createdById: admin.user.id,
        actions: [{ type: 'updateField', field: 'status', value: 'Closed' }, { type: 'sendEmail', template: 'thanks' }, { type: 'createTask', subject: 'x' }] },
    });

    const run = await call('post', `/api/macros/${macro.id}/execute`, { recordId: kase.id });
    expect(run.status).toBe(200);
    expect(JSON.stringify(run.body)).not.toMatch(/Email queued/);
    const results = run.body.results;
    expect(results.map(r => [r.action, r.success])).toEqual([['updateField', true], ['sendEmail', false], ['createTask', false]]);
    expect((await prisma.case.findUnique({ where: { id: kase.id } })).status).toBe('Closed');

    const bulk = await call('post', `/api/macros/${macro.id}/execute/bulk`, { recordIds: [kase.id] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.actionsNotRun).toEqual(['sendEmail', 'createTask']);

    refused(await call('post', `/api/macros/${macro.id}/schedule`, { schedule: '0 * * * *', module: 'cases' }), 'MACRO_SCHEDULE_UNAVAILABLE');
    expect((await prisma.macro.findUnique({ where: { id: macro.id } })).scheduled).toBeFalsy();

    const templates = (await call('get', '/api/macros/templates')).body;
    expect(templates.flatMap(t => t.actions.map(a => a.type)).every(type => ['updateField', 'addComment'].includes(type))).toBe(true);
  });
});

describe('the customer data platform', () => {
  test('ingests nothing, and does not count what it threw away', async () => {
    const stream = await prisma.dataStream.create({ data: { name: 'Web', source: 'web', mapping: {}, active: true } });

    refused(await call('post', `/api/cdp/streams/${stream.id}/ingest`, { records: [{ a: 1 }, { a: 2 }] }), 'CDP_INGEST_UNAVAILABLE');

    const after = await prisma.dataStream.findUnique({ where: { id: stream.id } });
    expect([after.recordCount, after.lastSyncAt]).toEqual([stream.recordCount, stream.lastSyncAt]);
  });
});

describe('web-to-case', () => {
  test('offers no snippet for a form that does not exist', async () => {
    const res = await call('get', '/api/public/web-to-case/embed');
    expect(res.status).toBe(200);
    expect(res.body.iframeSnippet).toBeUndefined();
    expect(res.body).toMatchObject({ hostedForm: null, apiEndpoint: expect.stringContaining('/api/public/web-to-case') });
  });
});

describe('security settings nothing enforces', () => {
  test('IP rules, field permissions and encryption policies are not saved, and no key is rotated', async () => {
    refused(await call('post', '/api/security/ip-rules', { ip: '10.0.0.1', type: 'block' }), 'IP_RULES_UNAVAILABLE');
    refused(await call('post', '/api/configuration/field-permissions', { roleId: admin.user.roleId, module: 'contacts', field: 'email', visible: false }), 'FIELD_SECURITY_UNAVAILABLE');
    refused(await call('post', '/api/configuration/field-permissions/bulk', { permissions: [{ roleId: admin.user.roleId, module: 'contacts', field: 'email' }] }), 'FIELD_SECURITY_UNAVAILABLE');
    refused(await call('post', '/api/security/encryption/policies', { module: 'contacts', field: 'email' }), 'ENCRYPTION_UNAVAILABLE');
    refused(await call('post', '/api/security/encryption/rotate-key'), 'ENCRYPTION_UNAVAILABLE');

    expect([await prisma.ipRule.count(), await prisma.fieldPermission.count(), await prisma.encryptionPolicy.count(), await prisma.encryptionKey.count()]).toEqual([0, 0, 0, 0]);
  });

  test('no sign-in code is sent by SMS or email', async () => {
    const res = await request(app).post('/api/security/mfa/challenge').send({ mfaToken: 'x', deviceId: 'y' });
    refused(res, 'MFA_CODE_DELIVERY_UNAVAILABLE');
    expect(await prisma.mfaChallenge.count()).toBe(0);
  });
});

describe('integrations', () => {
  test('take no sync schedule, and one never synced is not called healthy', async () => {
    const integration = await prisma.integration.create({ data: { name: 'Slack', provider: 'slack' } });

    refused(await call('put', `/api/integrations/${integration.id}/schedule`, { syncFrequency: 'hourly', syncEnabled: true }), 'INTEGRATION_SYNC_UNAVAILABLE');
    expect((await prisma.integration.findUnique({ where: { id: integration.id } })).syncFrequency).toBeNull();
    expect((await call('get', `/api/integrations/${integration.id}/health`)).body.status).toBe('never synced');
  });
});

describe('scheduled reports', () => {
  test('are not saved, as nothing sends them', async () => {
    const report = await prisma.report.create({ data: { name: 'Pipeline', module: 'deals', columns: [], createdById: admin.user.id } });

    refused(await call('post', `/api/reports/${report.id}/schedule`, { cron: '0 8 * * 1' }), 'REPORT_DELIVERY_UNAVAILABLE');
    refused(await call('post', '/api/analytics/scheduled-reports', { name: 'Weekly', reportId: report.id }), 'REPORT_DELIVERY_UNAVAILABLE');

    expect([await prisma.reportSchedule.count(), await prisma.scheduledReport.count()]).toEqual([0, 0]);
  });
});

describe('quote approval', () => {
  test('points at approval processes and leaves the quote as it was', async () => {
    const quote = await prisma.quote.create({ data: { number: 'QT-1', name: 'Q', status: 'Draft' } });

    refused(await call('post', `/api/quotes/${quote.id}/submit-approval`), 'QUOTE_APPROVAL_UNAVAILABLE');

    expect((await prisma.quote.findUnique({ where: { id: quote.id } })).status).toBe('Draft');
  });
});

describe('custom field values', () => {
  test('are not stored, and the refusal says why', async () => {
    const contact = await createTestContact();
    refused(await call('put', `/api/studio/values/contacts/${contact.id}`, { values: { tier: 'Gold' } }), 'CUSTOM_FIELD_VALUES_UNAVAILABLE');
  });
});

describe('the AI endpoints say what is a model and what is a rule', () => {
  test('batch lead scoring points to the scoring rules, and changes no score', async () => {
    const lead = await createTestLead({ score: 12 });

    refused(await call('post', '/api/ai/leads/batch-score', { leadIds: [lead.id] }), 'AI_LEAD_SCORING_UNAVAILABLE');

    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).score).toBe(12);
  });

  test('the config lists no made-up models, and deal prediction names its method', async () => {
    const config = (await call('get', '/api/ai/config')).body;
    expect(config.models).toBeUndefined();
    expect(config.settings).toBeUndefined();
    expect(config).toMatchObject({ generative: { provider: 'anthropic' }, leadScoring: { method: 'rules' }, dealPrediction: { method: 'stage weights' } });

    const deal = await createTestDeal(admin.user.id, { stage: 'Proposal' });
    const predicted = (await call('post', '/api/ai/deals/predict', { dealId: deal.id })).body;
    expect(predicted).toMatchObject({ method: 'stage weights', probability: 50 });
    expect(predicted.confidence).toBeUndefined();
  });
});

describe('what the answers claim', () => {
  test("a technician's day is in start order, not an optimized route", async () => {
    const res = await call('get', '/api/field-service/route/optimize');
    expect(res.body).toMatchObject({ orderedBy: 'startDate', optimized: false });
  });

  test('the retention policy is what the cleanup jobs do', async () => {
    const { policies } = (await call('get', '/api/data-export/retention-policy')).body;
    const days = Object.fromEntries(policies.map(p => [p.module, p.retentionDays]));
    expect(days).toEqual({ auditLogs: 90, notifications: 30, recycleBin: 30, loginHistory: null });
  });

  test('the audit cleanup job is described as deleting, which it does', async () => {
    const jobs = (await call('get', '/api/admin/jobs')).body.data;
    // It said "Archive old audit log entries"; nothing archives them.
    expect(jobs.find(j => j.name === 'cleanupAuditLogs').description).toBe('Delete audit log entries older than 90 days');
  });
});
