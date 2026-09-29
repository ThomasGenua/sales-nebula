/**
 * The tests refuse to run against a database that is not a test database.
 *
 * setup() force-resets the schema and cleanDatabase() truncates every table
 * before each test, and .env.example's DATABASE_URL is the app's own database,
 * so `npm test` on a fresh checkout emptied the seeded data.
 *
 * Every URL here points at a closed port with a made-up password, so if the
 * guard ever failed to throw nothing real could be reached.
 */
const { assertTestDatabase, cleanDatabase, setup } = require('./setup');

const original = { url: process.env.DATABASE_URL, allow: process.env.ALLOW_TEST_DB_RESET };
const url = name => `postgresql://someone:hunter2@127.0.0.1:1/${name}?schema=public`;

afterEach(() => {
  if (original.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original.url;
  if (original.allow === undefined) delete process.env.ALLOW_TEST_DB_RESET; else process.env.ALLOW_TEST_DB_RESET = original.allow;
});

describe('assertTestDatabase', () => {
  it('accepts a database named for testing', () => {
    for (const name of ['sales_nebula_test', 'review_test', 'test', 'test_db', 'app-test', 'e2e_test_2', 'Test']) {
      expect(() => assertTestDatabase(url(name))).not.toThrow();
    }
    expect(() => assertTestDatabase('file:./test.db')).not.toThrow();
  });

  it('refuses the app database, which is the default in .env.example', () => {
    expect(() => assertTestDatabase('postgresql://postgres:postgres@localhost:5432/salesnebula?schema=public'))
      .toThrow(/Refusing to run the tests: DATABASE_URL points at "salesnebula"/);
  });

  it('refuses names that only happen to contain the letters, and a SQLite dev file', () => {
    for (const name of ['latest', 'contest', 'sales_nebula', 'production', 'salesnebulatest']) {
      expect(() => assertTestDatabase(url(name))).toThrow(/Refusing to run the tests/);
    }
    expect(() => assertTestDatabase('file:./dev.db')).toThrow(/Refusing to run the tests/);
  });

  it('never puts the password in the message', () => {
    let message = '';
    try { assertTestDatabase(url('production')); } catch (err) { message = err.message; }
    expect(message).toMatch(/"production"/);
    expect(message).not.toMatch(/hunter2|someone/);
  });

  it('refuses when there is no DATABASE_URL at all', () => {
    delete process.env.DATABASE_URL;
    expect(() => assertTestDatabase()).toThrow(/DATABASE_URL is not set/);
  });

  it('reads DATABASE_URL when it is not given one', () => {
    process.env.DATABASE_URL = url('production');
    expect(() => assertTestDatabase()).toThrow(/points at "production"/);
    process.env.DATABASE_URL = url('sales_nebula_test');
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it('lets ALLOW_TEST_DB_RESET=true through, and only that exact value', () => {
    process.env.ALLOW_TEST_DB_RESET = 'true';
    expect(() => assertTestDatabase(url('production'))).not.toThrow();
    process.env.ALLOW_TEST_DB_RESET = '1';
    expect(() => assertTestDatabase(url('production'))).toThrow(/Refusing/);
  });
});

describe('the entry points', () => {
  it('cleanDatabase refuses before it touches anything', async () => {
    process.env.DATABASE_URL = url('production');
    await expect(cleanDatabase()).rejects.toThrow(/Refusing to run the tests/);
  });

  it('setup refuses before it opens a client or resets a schema', async () => {
    process.env.DATABASE_URL = url('production');
    await expect(setup()).rejects.toThrow(/Refusing to run the tests/);
  });
});
