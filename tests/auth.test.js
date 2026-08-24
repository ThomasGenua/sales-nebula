const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, authHeader,
} = require('./setup');

let app, prisma;

beforeAll(async () => {
  ({ prisma, app } = await setup());
});

afterAll(async () => {
  await teardown();
});

beforeEach(async () => {
  await cleanDatabase();
});

describe('POST /api/auth/register', () => {
  it('creates a new user and returns JWT', async () => {
    const role = await createTestRole();
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'new@test.com',
        password: 'securepass123',
        firstName: 'New',
        lastName: 'User',
        roleId: role.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('new@test.com');
    expect(res.body.user.firstName).toBe('New');
    expect(res.body.user.password).toBeUndefined(); // Should not leak password
  });

  it('rejects duplicate email', async () => {
    const role = await createTestRole();
    await prisma.user.create({
      data: { email: 'dupe@test.com', password: 'x', firstName: 'A', lastName: 'B', roleId: role.id },
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dupe@test.com', password: 'test', firstName: 'C', lastName: 'D', roleId: role.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exists/i);
  });

  it('rejects missing required fields', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'x@x.com' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns JWT for valid credentials', async () => {
    const { user } = await createTestUser({ email: 'login@test.com', password: 'mypassword' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.com', password: 'mypassword' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.id).toBe(user.id);
  });

  it('rejects wrong password', async () => {
    await createTestUser({ email: 'wrong@test.com', password: 'correct' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wrong@test.com', password: 'incorrect' });

    expect(res.status).toBe(401);
  });

  it('rejects non-existent user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@test.com', password: 'anything' });

    expect(res.status).toBe(401);
  });

  it('rejects inactive user', async () => {
    await createTestUser({ email: 'inactive@test.com', password: 'pass', active: false });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'inactive@test.com', password: 'pass' });

    expect(res.status).toBe(403);
  });
});

describe('Authentication middleware', () => {
  it('rejects requests without token', async () => {
    const res = await request(app).get('/api/contacts');
    expect(res.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const res = await request(app)
      .get('/api/contacts')
      .set('Authorization', 'Bearer invalid-garbage-token');

    expect(res.status).toBe(401);
  });

  it('accepts valid token', async () => {
    const { token } = await createTestUser();
    const res = await request(app)
      .get('/api/contacts')
      .set(authHeader(token));

    expect(res.status).toBe(200);
  });
});

describe('Permission middleware', () => {
  it('denies access when role lacks permission', async () => {
    const readOnlyRole = await createTestRole('ReadOnly', [
      { module: 'contacts', level: 'read' },
    ]);
    const { token } = await createTestUser({ roleId: readOnlyRole.id, email: 'readonly@test.com' });

    // Read should work
    const readRes = await request(app)
      .get('/api/contacts')
      .set(authHeader(token));
    expect(readRes.status).toBe(200);

    // Create should fail (needs 'edit')
    const createRes = await request(app)
      .post('/api/contacts')
      .set(authHeader(token))
      .send({ firstName: 'Blocked', lastName: 'User' });
    expect(createRes.status).toBe(403);
  });
});
