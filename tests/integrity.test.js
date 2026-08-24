const request = require('supertest');
const { diffFields, formatChanges, validateConstraints } = require('../src/utils/integrity');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestDeal, createTestContact, createTestCase, authHeader,
} = require('./setup');

let app, prisma, token, userId;

beforeAll(async () => {
  ({ prisma, app } = await setup());
});

afterAll(async () => {
  await teardown();
});

beforeEach(async () => {
  await cleanDatabase();
  const auth = await createTestUser();
  token = auth.token;
  userId = auth.user.id;
});

// ─── UNIT: Field Diff ───

describe('diffFields', () => {
  it('detects changed string fields', () => {
    const old = { firstName: 'John', lastName: 'Doe', email: 'john@test.com' };
    const updated = { firstName: 'Jane', email: 'jane@test.com' };
    const changes = diffFields(old, updated);

    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual({ field: 'firstName', oldValue: 'John', newValue: 'Jane' });
    expect(changes[1]).toEqual({ field: 'email', oldValue: 'john@test.com', newValue: 'jane@test.com' });
  });

  it('detects changed numeric fields', () => {
    const old = { value: 50000, probability: 25 };
    const updated = { value: 75000 };
    const changes = diffFields(old, updated);

    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('value');
    expect(changes[0].oldValue).toBe(50000);
    expect(changes[0].newValue).toBe(75000);
  });

  it('ignores unchanged fields', () => {
    const old = { firstName: 'John', lastName: 'Doe' };
    const updated = { firstName: 'John' };
    const changes = diffFields(old, updated);

    expect(changes).toHaveLength(0);
  });

  it('ignores protected fields', () => {
    const old = { updatedAt: new Date(), password: 'hash' };
    const updated = { updatedAt: new Date(), password: 'newhash' };
    const changes = diffFields(old, updated);

    expect(changes).toHaveLength(0);
  });
});

describe('formatChanges', () => {
  it('formats changes as human-readable string', () => {
    const changes = [
      { field: 'stage', oldValue: 'Qualification', newValue: 'Proposal' },
      { field: 'value', oldValue: 50000, newValue: 75000 },
    ];
    const formatted = formatChanges(changes);
    expect(formatted).toContain('stage');
    expect(formatted).toContain('Qualification');
    expect(formatted).toContain('Proposal');
  });
});

// ─── UNIT: Validation Constraints ───

describe('validateConstraints', () => {
  it('validates deal stage', () => {
    expect(validateConstraints('deal', { stage: 'Qualification' }).valid).toBe(true);
    expect(validateConstraints('deal', { stage: 'InvalidStage' }).valid).toBe(false);
  });

  it('validates deal probability range', () => {
    expect(validateConstraints('deal', { probability: 50 }).valid).toBe(true);
    expect(validateConstraints('deal', { probability: -1 }).valid).toBe(false);
    expect(validateConstraints('deal', { probability: 101 }).valid).toBe(false);
  });

  it('validates deal value non-negative', () => {
    expect(validateConstraints('deal', { value: 0 }).valid).toBe(true);
    expect(validateConstraints('deal', { value: -100 }).valid).toBe(false);
  });

  it('validates lead status', () => {
    expect(validateConstraints('lead', { status: 'Qualified' }).valid).toBe(true);
    expect(validateConstraints('lead', { status: 'Imaginary' }).valid).toBe(false);
  });

  it('validates case priority', () => {
    expect(validateConstraints('case', { priority: 'Critical' }).valid).toBe(true);
    expect(validateConstraints('case', { priority: 'Ultra' }).valid).toBe(false);
  });

  it('passes when module has no constraints', () => {
    expect(validateConstraints('accounts', { name: 'Anything' }).valid).toBe(true);
  });
});

// ─── INTEGRATION: Field-Level Audit in API ───

describe('Field-level audit tracking', () => {
  it('records field changes when updating a contact', async () => {
    const contact = await createTestContact({ firstName: 'AuditTest', lastName: 'Before', department: 'Sales' });

    await request(app)
      .put(`/api/contacts/${contact.id}`)
      .set(authHeader(token))
      .send({ firstName: 'AuditTest', lastName: 'After', department: 'Engineering' });

    // Check audit log
    const logs = await prisma.auditLog.findMany({
      where: { module: 'contacts', recordId: contact.id, action: 'update' },
      orderBy: { createdAt: 'desc' },
    });

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const details = logs[0].details;
    expect(details).toContain('lastName');
    expect(details).toContain('Before');
    expect(details).toContain('After');
    expect(details).toContain('department');
  });
});

// ─── INTEGRATION: Optimistic Locking ───

describe('Optimistic locking', () => {
  it('rejects update with stale version', async () => {
    const contact = await createTestContact({ firstName: 'Lock', lastName: 'Test' });

    // First update (succeeds)
    await request(app)
      .put(`/api/contacts/${contact.id}`)
      .set(authHeader(token))
      .send({ firstName: 'Updated', _version: contact.updatedAt.toISOString() });

    // Second update with OLD version (should conflict)
    const res = await request(app)
      .put(`/api/contacts/${contact.id}`)
      .set(authHeader(token))
      .send({ firstName: 'Stale', _version: contact.updatedAt.toISOString() });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('allows update without version (backward compatible)', async () => {
    const contact = await createTestContact({ firstName: 'NoVer', lastName: 'Test' });

    const res = await request(app)
      .put(`/api/contacts/${contact.id}`)
      .set(authHeader(token))
      .send({ firstName: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('Updated');
  });
});

// ─── INTEGRATION: Prisma Error Handling ───

describe('Database error handling', () => {
  it('handles unique constraint violation', async () => {
    const { token } = await createTestUser({ email: 'unique@test.com' });

    // Try to create product with duplicate code
    await prisma.product.create({ data: { name: 'P1', code: 'DUPE-001', price: 10 } });

    const res = await request(app)
      .post('/api/products')
      .set(authHeader(token))
      .send({ name: 'P2', code: 'DUPE-001', price: 20 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/duplicate/i);
  });
});

// ─── INTEGRATION: Bulk Operation Limits ───

describe('Bulk operation limits', () => {
  it('rejects bulk delete with more than 100 IDs', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `fake-id-${i}`);

    const res = await request(app)
      .post('/api/contacts/bulk-delete')
      .set(authHeader(token))
      .send({ ids });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
  });
});
