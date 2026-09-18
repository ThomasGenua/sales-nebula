const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestContact, createTestAccount, authHeader,
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

describe('GET /api/contacts', () => {
  it('returns paginated contact list', async () => {
    await createTestContact({ firstName: 'Alice', lastName: 'Smith' });
    await createTestContact({ firstName: 'Bob', lastName: 'Jones' });

    const res = await request(app)
      .get('/api/contacts')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.meta.page).toBe(1);
  });

  it('supports search by name', async () => {
    await createTestContact({ firstName: 'Alice', lastName: 'Smith' });
    await createTestContact({ firstName: 'Bob', lastName: 'Jones' });

    const res = await request(app)
      .get('/api/contacts?search=alice')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].firstName).toBe('Alice');
  });

  it('supports pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await createTestContact({ firstName: `User${i}`, lastName: `Test${i}` });
    }

    const res = await request(app)
      .get('/api/contacts?page=1&limit=2')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(5);
    expect(res.body.meta.pages).toBe(3);
  });

  it('supports sorting', async () => {
    await createTestContact({ firstName: 'Zara', lastName: 'First' });
    await createTestContact({ firstName: 'Adam', lastName: 'Second' });

    const res = await request(app)
      .get('/api/contacts?sortBy=firstName&sortDir=asc')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data[0].firstName).toBe('Adam');
    expect(res.body.data[1].firstName).toBe('Zara');
  });
});

describe('POST /api/contacts', () => {
  it('creates a contact', async () => {
    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(token))
      .send({ firstName: 'New', lastName: 'Contact', email: 'new@test.com' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.firstName).toBe('New');
    expect(res.body.email).toBe('new@test.com');
  });

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(token))
      .send({ email: 'nofirst@test.com' }); // Missing firstName and lastName

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it('associates with account', async () => {
    const account = await createTestAccount({ name: 'Acme Corp' });

    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(token))
      .send({ firstName: 'Corp', lastName: 'Guy', accountId: account.id });

    expect(res.status).toBe(201);
    expect(res.body.account.name).toBe('Acme Corp');
  });
});

describe('GET /api/contacts/:id', () => {
  it('returns a single contact', async () => {
    const contact = await createTestContact({ firstName: 'Detail', lastName: 'View' });

    const res = await request(app)
      .get(`/api/contacts/${contact.id}`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('Detail');
  });

  it('returns 404 for non-existent', async () => {
    const res = await request(app)
      .get('/api/contacts/non-existent-id-12345')
      .set(authHeader(token));

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/contacts/:id', () => {
  it('updates a contact', async () => {
    const contact = await createTestContact({ firstName: 'Before', lastName: 'Update' });

    const res = await request(app)
      .put(`/api/contacts/${contact.id}`)
      .set(authHeader(token))
      .send({ firstName: 'After', title: 'CTO' });

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('After');
    expect(res.body.title).toBe('CTO');
    expect(res.body.lastName).toBe('Update'); // Unchanged
  });

  it('strips protected fields', async () => {
    const contact = await createTestContact();
    const originalId = contact.id;

    const res = await request(app)
      .put(`/api/contacts/${contact.id}`)
      .set(authHeader(token))
      .send({ id: 'fake-id', createdAt: '2000-01-01', firstName: 'OK' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(originalId); // ID not changed
  });
});

describe('DELETE /api/contacts/:id', () => {
  it('deletes a contact', async () => {
    const contact = await createTestContact();

    const res = await request(app)
      .delete(`/api/contacts/${contact.id}`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify gone
    const check = await prisma.contact.findUnique({ where: { id: contact.id } });
    // Deletes are soft, so the row stays with deletedAt set and the record
    // lands in the recycle bin; it must no longer be reachable through the API.
    expect(check.deletedAt).not.toBeNull();
  });
});

describe('POST /api/contacts/bulk-delete', () => {
  it('deletes multiple contacts', async () => {
    const c1 = await createTestContact({ firstName: 'Bulk1', lastName: 'Del' });
    const c2 = await createTestContact({ firstName: 'Bulk2', lastName: 'Del' });
    await createTestContact({ firstName: 'Keep', lastName: 'Me' });

    const res = await request(app)
      .post('/api/contacts/bulk-delete')
      .set(authHeader(token))
      .send({ ids: [c1.id, c2.id] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const remaining = await prisma.contact.count();
    expect(remaining).toBe(1);
  });
});

describe('POST /api/contacts/bulk-update', () => {
  it('updates multiple contacts', async () => {
    const c1 = await createTestContact({ firstName: 'Bulk1', lastName: 'Up' });
    const c2 = await createTestContact({ firstName: 'Bulk2', lastName: 'Up' });

    const res = await request(app)
      .post('/api/contacts/bulk-update')
      .set(authHeader(token))
      .send({ ids: [c1.id, c2.id], data: { department: 'Engineering' } });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const updated = await prisma.contact.findUnique({ where: { id: c1.id } });
    expect(updated.department).toBe('Engineering');
  });
});

describe('POST /api/contacts/:id/merge', () => {
  it('merges two contacts', async () => {
    const primary = await createTestContact({ firstName: 'Primary', lastName: 'Contact', email: 'primary@test.com' });
    const duplicate = await createTestContact({ firstName: 'Dupe', lastName: 'Contact', phone: '555-1234' });

    const res = await request(app)
      .post(`/api/contacts/${primary.id}/merge`)
      .set(authHeader(token))
      .send({ mergeId: duplicate.id, fields: { phone: '555-1234' } });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('555-1234');
    expect(res.body.firstName).toBe('Primary'); // Primary keeps its values

    // Duplicate should be deleted
    const dupe = await prisma.contact.findUnique({ where: { id: duplicate.id } });
    expect(dupe).toBeNull();
  });
});

describe('GET /api/contacts/:id/duplicates', () => {
  it('finds duplicates by name', async () => {
    const contact = await createTestContact({ firstName: 'John', lastName: 'Smith', email: 'john@test.com' });
    await createTestContact({ firstName: 'John', lastName: 'Smith', email: 'john2@test.com' }); // Duplicate name
    await createTestContact({ firstName: 'Jane', lastName: 'Doe' }); // Not a duplicate

    const res = await request(app)
      .get(`/api/contacts/${contact.id}/duplicates`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].firstName).toBe('John');
  });
});

describe('POST /api/contacts/import-csv', () => {
  it('imports multiple contacts', async () => {
    const res = await request(app)
      .post('/api/contacts/import-csv')
      .set(authHeader(token))
      .send({
        records: [
          { firstName: 'Import1', lastName: 'CSV', email: 'i1@test.com' },
          { firstName: 'Import2', lastName: 'CSV', email: 'i2@test.com' },
          { firstName: 'Import3', lastName: 'CSV', email: 'i3@test.com' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);

    const count = await prisma.contact.count();
    expect(count).toBe(3);
  });
});

describe('GET /api/contacts/:id/timeline', () => {
  it('returns timeline data', async () => {
    const contact = await createTestContact();

    const res = await request(app)
      .get(`/api/contacts/${contact.id}/timeline`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('activities');
    expect(res.body).toHaveProperty('emails');
    expect(res.body).toHaveProperty('cases');
    expect(res.body).toHaveProperty('quotes');
  });
});
