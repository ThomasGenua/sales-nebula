/**
 * Every path that writes a CRUD module's records runs the same rules
 * (services/recordWrites.js): the module's own hooks, validation, duplicate
 * and assignment rules before the write; audit, workflows and webhooks after
 * it. They were the CRUD router's create and edit alone, so a bulk update, an
 * import, a lead conversion or a case opened by email skipped every one.
 */
const request = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, createTestAccount, authHeader,
} = require('./setup');

let app, prisma, role, admin;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  role = await createTestRole('Admin');
  admin = await createTestUser({ email: 'admin@paths.test', roleId: role.id });
});

/** A rule with no actions: each run is logged against the record it ran on. */
const ruleOn = (module, trigger, conditions = []) => prisma.workflow.create({
  data: { name: `${module} ${trigger}`, module, trigger, conditions, actions: [], active: true },
});
const firedFor = async workflow => (await prisma.workflowLog.findMany({
  where: { workflowId: workflow.id, success: true }, select: { recordId: true },
})).map(log => log.recordId).sort();

const post = (path, body) => request(app).post(path).set(authHeader(admin.token)).send(body);

describe('CRUD bulk routes', () => {
  test('a bulk update runs each record through its rules, its stage history and the workflows', async () => {
    const account = await createTestAccount();
    const deals = [];
    for (const value of [100, 500, 900]) {
      deals.push(await prisma.deal.create({ data: { name: `Deal ${value}`, value, stage: 'Prospecting', accountId: account.id } }));
    }
    const onUpdate = await ruleOn('deals', 'update');
    const onMove = await ruleOn('deals', 'statusChange');
    await prisma.validationRule.create({
      data: {
        name: 'Small deals are not won', module: 'deals', active: true, errorMessage: 'Too small to close as won',
        condition: { and: [{ field: 'stage', operator: 'equals', value: 'Closed Won' }, { field: 'value', operator: 'lt', value: 200 }] },
      },
    });

    const res = await post('/api/deals/bulk-update', { ids: deals.map(d => d.id), data: { stage: 'Closed Won' } });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    // The rule refused one, which is left as it was and reported.
    expect(res.body.failed).toEqual([{ id: deals[0].id, error: 'Too small to close as won', code: 'VALIDATION_RULE' }]);
    expect((await prisma.deal.findUnique({ where: { id: deals[0].id } })).stage).toBe('Prospecting');

    const moved = [deals[1].id, deals[2].id].sort();
    expect(await firedFor(onUpdate)).toEqual(moved);
    expect(await firedFor(onMove)).toEqual(moved);
    const history = await prisma.dealStageHistory.findMany({ select: { dealId: true, fromStage: true, toStage: true, changedById: true } });
    expect(history.map(h => h.dealId).sort()).toEqual(moved);
    expect(history.every(h => h.fromStage === 'Prospecting' && h.toStage === 'Closed Won' && h.changedById === admin.user.id)).toBe(true);
  });

  test('a bulk update stamps a closed case as an edit does, and records its status change', async () => {
    const opened = await prisma.case.create({ data: { subject: 'Printer on fire', caseNumber: 'CS-9001', status: 'New' } });

    const res = await post('/api/cases/bulk-update', { ids: [opened.id], data: { status: 'Closed' } });

    expect(res.body.updated).toBe(1);
    const closed = await prisma.case.findUnique({ where: { id: opened.id } });
    expect(closed.closedAt).toBeInstanceOf(Date);
    const history = await prisma.caseStatusHistory.findMany({ where: { caseId: opened.id } });
    expect(history.map(h => [h.fromStatus, h.toStatus])).toEqual([['New', 'Closed']]);
  });
});

describe('Import, the bulk API, mass actions and mobile sync', () => {
  test('an import runs each row through the assignment and validation rules and the create workflows', async () => {
    const ana = (await createTestUser({ email: 'ana@paths.test', roleId: role.id })).user;
    const ben = (await createTestUser({ email: 'ben@paths.test', roleId: role.id })).user;
    await prisma.assignmentRule.create({ data: { name: 'Spread leads', module: 'leads', type: 'round_robin', assignees: [ana.id, ben.id], active: true } });
    await prisma.validationRule.create({
      data: { name: 'No spam', module: 'leads', active: true, errorMessage: 'Spam is not a lead', condition: { field: 'company', operator: 'equals', value: 'Spam Inc' } },
    });
    const onCreate = await ruleOn('leads', 'create');

    const res = await post('/api/import/execute', {
      module: 'leads',
      records: [
        { firstName: 'Ada', lastName: 'One', company: 'Acme', email: 'ada@acme.test' },
        { firstName: 'Sam', lastName: 'Spam', company: 'Spam Inc', email: 'sam@spam.test' },
        { firstName: 'Bo', lastName: 'Two', company: 'Bolt', email: 'bo@bolt.test' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, skipped: 1 });
    expect(res.body.errors).toEqual([{ row: 2, error: 'Spam is not a lead' }]);
    const leads = await prisma.lead.findMany({ orderBy: { firstName: 'asc' } });
    expect(leads.map(l => [l.firstName, l.ownerId])).toEqual([['Ada', ana.id], ['Bo', ben.id]]);
    expect(await firedFor(onCreate)).toEqual(leads.map(l => l.id).sort());
    expect(await prisma.auditLog.count({ where: { module: 'leads', action: 'create', details: 'Created lead (import)' } })).toBe(2);
  });

  test('a bulk API insert numbers each case and runs its rules; a delete puts them in the recycle bin', async () => {
    const onCreate = await ruleOn('cases', 'create');

    const inserted = await post('/api/bulk/insert', { module: 'cases', records: [{ subject: 'First' }, { subject: 'Second' }, { priority: 'High' }] });

    // The third has no subject, which a case needs: it fails alone.
    expect(inserted.body).toMatchObject({ success: 2, failed: 1 });
    expect(inserted.body.errors).toEqual([{ index: 2, error: 'Validation failed (subject: required)' }]);
    const cases = await prisma.case.findMany({ orderBy: { subject: 'asc' } });
    expect(cases.every(c => /^CS-\d+$/.test(c.caseNumber))).toBe(true);
    expect(await firedFor(onCreate)).toEqual(cases.map(c => c.id).sort());

    const removed = await post('/api/bulk/delete', { module: 'cases', ids: cases.map(c => c.id) });

    expect(removed.body.deleted).toBe(2);
    expect(await prisma.case.count({ where: { deletedAt: null } })).toBe(0);
    expect(await prisma.recycleBinItem.count({ where: { module: 'cases' } })).toBe(2);
  });

  test('a mass update closes cases as an edit does, with the status change rules', async () => {
    const opened = [];
    for (const n of [1, 2]) opened.push(await prisma.case.create({ data: { subject: `Case ${n}`, caseNumber: `CS-800${n}`, status: 'New' } }));
    const onMove = await ruleOn('cases', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Closed' }]);

    const res = await post('/api/mass-actions/update', { module: 'cases', recordIds: opened.map(c => c.id), updates: { status: 'Closed' } });

    expect(res.body).toMatchObject({ success: true, updated: 2 });
    const closed = await prisma.case.findMany();
    expect(closed.every(c => c.closedAt instanceof Date)).toBe(true);
    expect(await prisma.caseStatusHistory.count({ where: { toStatus: 'Closed' } })).toBe(2);
    expect(await firedFor(onMove)).toEqual(opened.map(c => c.id).sort());
  });

  test('a mass reassignment runs the update rules for each record', async () => {
    const other = (await createTestUser({ email: 'other@paths.test', roleId: role.id })).user;
    const account = await createTestAccount();
    const deal = await prisma.deal.create({ data: { name: 'Mine', value: 1, stage: 'Prospecting', accountId: account.id, ownerId: admin.user.id } });
    const onUpdate = await ruleOn('deals', 'update', [{ field: 'ownerId', operator: 'changed' }]);

    const res = await post('/api/mass-actions/reassign', { module: 'deals', recordIds: [deal.id], newOwnerId: other.id });

    expect(res.body.reassigned).toBe(1);
    expect(await firedFor(onUpdate)).toEqual([deal.id]);
  });

  test('a mobile sync saves offline changes as online ones are: rules, stage history and workflows', async () => {
    const account = await createTestAccount();
    const onCreate = await ruleOn('deals', 'create');

    const created = await post('/api/mobile/sync', { changes: [{ module: 'deals', action: 'create', localId: 'l1', data: { name: 'Offline deal', value: 5, stage: 'Prospecting', accountId: account.id } }] });
    const serverId = created.body.results[0].serverId;
    expect(created.body.results[0].status).toBe('created');

    const moved = await post('/api/mobile/sync', { changes: [{ module: 'deals', action: 'update', id: serverId, data: { stage: 'Negotiation' } }] });

    expect(moved.body.results[0].status).toBe('updated');
    expect(await firedFor(onCreate)).toEqual([serverId]);
    const history = await prisma.dealStageHistory.findMany({ where: { dealId: serverId } });
    expect(history.map(h => [h.fromStage, h.toStage])).toEqual([['Prospecting', 'Negotiation']]);
    expect((await prisma.deal.findUnique({ where: { id: serverId } })).ownerId).toBe(admin.user.id);
  });
});

describe('Conversions and the channels customers write through', () => {
  const EMAIL_SECRET = 'test-email-to-case-secret';
  beforeAll(() => { process.env.EMAIL_TO_CASE_SECRET = EMAIL_SECRET; });

  test('a lead conversion runs the create rules on what it makes, after it commits, and a rule can refuse it', async () => {
    const lead = await prisma.lead.create({ data: { firstName: 'Ada', lastName: 'Lovelace', company: 'Engines Ltd', email: 'ada@engines.test', status: 'Qualified' } });
    const onAccount = await ruleOn('accounts', 'create');
    const onContact = await ruleOn('contacts', 'create');
    const onDeal = await ruleOn('deals', 'create');
    const onLeadMove = await ruleOn('leads', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Converted' }]);

    const res = await post(`/api/leads/${lead.id}/convert`, { createAccount: true, createDeal: true, dealName: 'Engines deal', dealValue: 1000 });

    expect(res.status).toBe(200);
    expect(await firedFor(onAccount)).toEqual([res.body.account.id]);
    expect(await firedFor(onContact)).toEqual([res.body.contact.id]);
    expect(await firedFor(onDeal)).toEqual([res.body.deal.id]);
    expect(await firedFor(onLeadMove)).toEqual([lead.id]);
  });

  test("a rule that refuses the new contact refuses the conversion, and nothing is kept", async () => {
    const lead = await prisma.lead.create({ data: { firstName: 'No', lastName: 'Email', company: 'Quiet Co', status: 'Qualified' } });
    await prisma.validationRule.create({
      data: { name: 'Contacts need an email', module: 'contacts', active: true, errorMessage: 'A contact needs an email address', condition: { field: 'email', operator: 'isEmpty' } },
    });

    const res = await post(`/api/leads/${lead.id}/convert`, { createAccount: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A contact needs an email address');
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).convertedAt).toBeNull();
  });

  test('web-to-lead takes its owner from the assignment rules and runs the create rules', async () => {
    const ana = (await createTestUser({ email: 'ana2@paths.test', roleId: role.id })).user;
    await prisma.assignmentRule.create({
      data: { name: 'Acme to Ana', module: 'leads', type: 'rule_based', assignees: [ana.id], active: true, conditions: [{ field: 'company', operator: 'contains', value: 'Acme' }] },
    });
    const onCreate = await ruleOn('leads', 'create');

    const res = await request(app).post('/api/public/web-to-lead').send({ firstName: 'Web', lastName: 'Visitor', company: 'Acme Corp', email: 'web@acme.test' });

    expect(res.status).toBe(201);
    const lead = await prisma.lead.findUnique({ where: { id: res.body.leadId } });
    expect(lead.ownerId).toBe(ana.id);
    expect(await firedFor(onCreate)).toEqual([lead.id]);
  });

  test("web-to-lead answers a duplicate rule with its message alone, not the other lead's id", async () => {
    await prisma.lead.create({ data: { firstName: 'Old', lastName: 'Lead', company: 'Phone Co', email: 'old@phone.test', phone: '555-0100' } });
    await prisma.duplicateRule.create({
      data: { name: 'Same phone', module: 'leads', matchFields: [{ field: 'phone', weight: 100 }], threshold: 100, action: 'block', active: true },
    });

    const res = await request(app).post('/api/public/web-to-lead').send({ firstName: 'New', lastName: 'Lead', company: 'Phone Co', email: 'new@phone.test', phone: '555-0100' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This looks like a duplicate of an existing lead.', code: 'DUPLICATE_RECORD' });
  });

  test('a case opened by email, by the web form or in the portal gets a number, an owner and the create rules', async () => {
    const agent = (await createTestUser({ email: 'agent@paths.test', roleId: role.id })).user;
    await prisma.assignmentRule.create({ data: { name: 'Support queue', module: 'cases', type: 'round_robin', assignees: [agent.id], active: true } });
    const onCreate = await ruleOn('cases', 'create');
    const contact = await prisma.contact.create({ data: { firstName: 'Cat', lastName: 'Customer', email: 'cat@customer.test' } });
    const customer = await createTestUser({ email: 'cat@customer.test', roleId: role.id });
    await prisma.user.update({ where: { id: customer.user.id }, data: { isPortalUser: true, contactId: contact.id } });

    const emailed = await request(app).post('/api/public/email-to-case/inbound').set('X-Webhook-Secret', EMAIL_SECRET)
      .send({ from: 'Cat <cat@customer.test>', subject: 'Printer jammed', body: 'Again.' });
    const formed = await request(app).post('/api/public/web-to-case').send({ name: 'Cat Customer', email: 'cat@customer.test', subject: 'Scanner too' });
    const portaled = await request(app).post('/api/portal/my/cases').set(authHeader(customer.token)).send({ subject: 'And the fax' });

    expect([emailed.status, formed.status, portaled.status]).toEqual([201, 201, 201]);
    const cases = await prisma.case.findMany();
    expect(cases).toHaveLength(3);
    expect(cases.every(c => /^CS-\d+$/.test(c.caseNumber) && c.ownerId === agent.id)).toBe(true);
    expect(await firedFor(onCreate)).toEqual(cases.map(c => c.id).sort());
  });

  test("an emailed case a rule refuses gets the rule's message back, and no case", async () => {
    await prisma.validationRule.create({
      data: { name: 'No spam', module: 'cases', active: true, errorMessage: 'Looks like spam', condition: { field: 'subject', operator: 'contains', value: 'lottery' } },
    });

    const res = await request(app).post('/api/public/email-to-case/inbound').set('X-Webhook-Secret', EMAIL_SECRET)
      .send({ from: 'win@lottery.test', subject: 'You won the lottery', body: '...' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Looks like spam', code: 'VALIDATION_RULE' });
    expect(await prisma.case.count()).toBe(0);
  });

  test("a customer's reply reopens a closed case as an edit would: closedAt cleared, history kept, rules run", async () => {
    const { ingestMessages } = require('../src/services/inboundIngest');
    const account = await prisma.inboundEmailAccount.create({ data: { name: 'Support', username: 'support@ourco.test', autoCreateCase: true, active: true } });
    const closed = await prisma.case.create({
      data: { subject: 'Broken widget', caseNumber: 'CS-0042', status: 'Closed', closedAt: new Date(), contactEmail: 'kim@customer.test' },
    });
    const onMove = await ruleOn('cases', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Open' }]);

    const result = await ingestMessages(prisma, account, [{ from: 'kim@customer.test', subject: 'Re: Broken widget [Case# CS-0042]', text: 'Still broken', messageId: '<m1@customer.test>' }]);

    expect(result.repliesLinked).toBe(1);
    const reopened = await prisma.case.findUnique({ where: { id: closed.id } });
    expect([reopened.status, reopened.closedAt, reopened.emailCount]).toEqual(['Open', null, 1]);
    const history = await prisma.caseStatusHistory.findMany({ where: { caseId: closed.id } });
    expect(history.map(h => [h.fromStatus, h.toStatus])).toEqual([['Closed', 'Open']]);
    expect(await firedFor(onMove)).toEqual([closed.id]);
  });
});

describe("The modules' own actions", () => {
  test('escalating a case runs its status rules and keeps one history entry, not two', async () => {
    const cs = await prisma.case.create({ data: { subject: 'Slow', caseNumber: 'CS-0100', status: 'Open', priority: 'Medium' } });
    const onMove = await ruleOn('cases', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Escalated' }]);

    const res = await post(`/api/cases/${cs.id}/escalate`, { reason: 'Waited a week' });

    expect(res.status).toBe(200);
    expect([res.body.status, res.body.priority, res.body.isEscalated]).toEqual(['Escalated', 'High', true]);
    expect(await firedFor(onMove)).toEqual([cs.id]);
    const history = await prisma.caseStatusHistory.findMany({ where: { caseId: cs.id } });
    expect(history.map(h => [h.fromStatus, h.toStatus])).toEqual([['Open', 'Escalated']]);
  });

  test('activating an order, and renewing a contract, run the rules on what they change and make', async () => {
    const account = await createTestAccount();
    const order = await prisma.order.create({ data: { orderNumber: 'ORD-9001', accountId: account.id, status: 'Draft' } });
    const contract = await prisma.contract.create({
      data: { contractNumber: 'CON-9001', name: 'Support', accountId: account.id, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), status: 'Activated' },
    });
    const onActivate = await ruleOn('orders', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Activated' }]);
    const onContract = await ruleOn('contracts', 'create');

    const activated = await post(`/api/orders/${order.id}/activate`, {});
    const renewed = await post(`/api/contracts/${contract.id}/renew`, { months: 12 });

    expect([activated.status, renewed.status]).toEqual([200, 201]);
    expect(await firedFor(onActivate)).toEqual([order.id]);
    expect(renewed.body.contractNumber).toMatch(/^CON-\d+$/);
    expect(await firedFor(onContract)).toEqual([renewed.body.id]);
  });

  test("a macro's field updates are one edit: a case it closes gets closedAt, its history and the status rules", async () => {
    const cs = await prisma.case.create({ data: { subject: 'Done', caseNumber: 'CS-0101', status: 'Open' } });
    const onMove = await ruleOn('cases', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Closed' }]);
    const macro = await post('/api/macros', {
      name: 'Close it', module: 'cases',
      actions: [{ type: 'updateField', field: 'status', value: 'Closed' }, { type: 'updateField', field: 'priority', value: 'Low' }],
    });

    const res = await post(`/api/macros/${macro.body.id}/execute`, { recordId: cs.id });

    expect(res.body.results.map(r => [r.field, r.success])).toEqual([['status', true], ['priority', true]]);
    const closed = await prisma.case.findUnique({ where: { id: cs.id } });
    expect([closed.status, closed.priority, closed.closedAt instanceof Date]).toEqual(['Closed', 'Low', true]);
    expect(await prisma.caseStatusHistory.count({ where: { caseId: cs.id } })).toBe(1);
    expect(await firedFor(onMove)).toEqual([cs.id]);
  });

  test("the copilot's stage move keeps one stage history entry and runs the deal's rules", async () => {
    const account = await createTestAccount();
    const deal = await prisma.deal.create({ data: { name: 'Copilot deal', value: 10, stage: 'Prospecting', accountId: account.id, ownerId: admin.user.id } });
    const onMove = await ruleOn('deals', 'statusChange');

    const res = await post('/api/copilot/actions', { action: 'update_deal_stage', params: { dealId: deal.id, stage: 'Negotiation' } });

    expect(res.status).toBe(200);
    expect(await firedFor(onMove)).toEqual([deal.id]);
    expect(await prisma.dealStageHistory.count({ where: { dealId: deal.id } })).toBe(1);
  });

  test('merging contacts edits the survivor as an edit would and deletes the other as a delete does', async () => {
    const primary = await prisma.contact.create({ data: { firstName: 'Pri', lastName: 'Mary', email: 'pri@merge.test' } });
    const dupe = await prisma.contact.create({ data: { firstName: 'Du', lastName: 'Plicate', phone: '555-0199' } });
    const onUpdate = await ruleOn('contacts', 'update');

    const res = await post(`/api/contacts/${primary.id}/merge`, { mergeId: dupe.id, fields: { phone: '555-0199' } });

    expect(res.status).toBe(200);
    expect(await firedFor(onUpdate)).toEqual([primary.id]);
    expect((await prisma.contact.findUnique({ where: { id: dupe.id } })).deletedAt).not.toBeNull();
    expect(await prisma.recycleBinItem.count({ where: { recordId: dupe.id } })).toBe(1);
  });

  test('completing an activity runs its status rules, and its follow-up is made as a new activity is', async () => {
    const task = await prisma.activity.create({ data: { type: 'Call', subject: 'Ring them', status: 'Scheduled', ownerId: admin.user.id } });
    const onDone = await ruleOn('activities', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Completed' }]);
    const onCreate = await ruleOn('activities', 'create');

    const res = await post(`/api/activities/${task.id}/complete`, { followUp: { subject: 'Ring again' } });

    expect(res.status).toBe(200);
    expect(await firedFor(onDone)).toEqual([task.id]);
    const followUp = await prisma.activity.findFirst({ where: { subject: 'Ring again' } });
    expect(await firedFor(onCreate)).toEqual([followUp.id]);
  });
});
