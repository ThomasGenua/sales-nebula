/**
 * The signing key in production.
 *
 * .env.example and docker-compose.yml shipped "change-this-to-a-strong-random-
 * secret-in-production", and the only check was "is it set". A stack started
 * from either signed sessions with a key anyone can read in the repository, so
 * anyone could sign an administrator's token. These pin that a placeholder or
 * a key too short to be one stops the app in production, and leave
 * development and tests alone.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const {
  resolveJwtSecret, resolveMailSecret, weakSecretReason, DEV_FALLBACK, MIN_SECRET_LENGTH,
} = require('../src/utils/secrets');

const ROOT = path.join(__dirname, '..');
const PLACEHOLDER = 'change-this-to-a-strong-random-secret-in-production';
const STRONG = 'k9Vd2mQx7LpR4tYw8Zc1NfHj6BsA3eUg5XoI0yTqMvDrKlPz'; // 48 characters
const original = { ...process.env };

function environment(env = {}) {
  for (const key of ['NODE_ENV', 'JWT_SECRET', 'MAIL_SECRET']) delete process.env[key];
  Object.assign(process.env, env);
}

afterEach(() => {
  for (const key of ['NODE_ENV', 'JWT_SECRET', 'MAIL_SECRET']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  jest.restoreAllMocks();
});

describe('weakSecretReason', () => {
  it('names every value this repository has shipped, whatever its case or padding', () => {
    for (const value of [PLACEHOLDER, DEV_FALLBACK, 'change-this-secret', 'sales-nebula-mail-key', ` ${PLACEHOLDER} `, PLACEHOLDER.toUpperCase(), 'changeme', 'Change_Me_Please_Change_Me_Please_1']) {
      expect(weakSecretReason(value)).toMatch(/placeholder|shorter/);
    }
  });

  it('refuses a key shorter than the hash it feeds', () => {
    expect(weakSecretReason('a'.repeat(MIN_SECRET_LENGTH - 1))).toMatch(/shorter than 32/);
    expect(weakSecretReason('a'.repeat(MIN_SECRET_LENGTH))).toBeNull();
  });

  it('accepts a generated key', () => {
    expect(weakSecretReason(STRONG)).toBeNull();
    expect(weakSecretReason(require('crypto').randomBytes(48).toString('base64'))).toBeNull();
  });
});

describe('resolveJwtSecret in production', () => {
  it('refuses the placeholder from .env.example and docker-compose.yml', () => {
    environment({ NODE_ENV: 'production', JWT_SECRET: PLACEHOLDER });
    expect(() => resolveJwtSecret({ exit: false })).toThrow(/JWT_SECRET is a placeholder/);
  });

  it('refuses a key that is too short, and says how to make one', () => {
    environment({ NODE_ENV: 'production', JWT_SECRET: 'hunter2hunter2' });
    expect(() => resolveJwtSecret({ exit: false })).toThrow(/shorter than 32 characters.*openssl rand -base64 48/);
  });

  it('refuses the development fallback when it is set explicitly', () => {
    environment({ NODE_ENV: 'production', JWT_SECRET: DEV_FALLBACK });
    expect(() => resolveJwtSecret({ exit: false })).toThrow(/placeholder/);
  });

  it('still refuses a missing key', () => {
    environment({ NODE_ENV: 'production' });
    expect(() => resolveJwtSecret({ exit: false })).toThrow(/JWT_SECRET is not set/);
  });

  it('accepts a real key', () => {
    environment({ NODE_ENV: 'production', JWT_SECRET: STRONG });
    expect(resolveJwtSecret({ exit: false })).toBe(STRONG);
  });

  it('exits with the reason when nobody asked to handle it', () => {
    environment({ NODE_ENV: 'production', JWT_SECRET: PLACEHOLDER });
    const exit = jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => resolveJwtSecret()).toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toMatch(/FATAL: JWT_SECRET is a placeholder/);
  });
});

describe('outside production', () => {
  it('lets development and tests keep whatever they set', () => {
    for (const NODE_ENV of ['development', 'test']) {
      environment({ NODE_ENV, JWT_SECRET: PLACEHOLDER });
      expect(resolveJwtSecret({ exit: false })).toBe(PLACEHOLDER);
      environment({ NODE_ENV, JWT_SECRET: 'short' });
      expect(resolveJwtSecret({ exit: false })).toBe('short');
    }
  });
});

describe('resolveMailSecret in production', () => {
  it('holds MAIL_SECRET to the same rule, since it encrypts stored mailbox credentials', () => {
    environment({ NODE_ENV: 'production', JWT_SECRET: STRONG, MAIL_SECRET: 'password' });
    expect(() => resolveMailSecret({ exit: false })).toThrow(/MAIL_SECRET is shorter than 32/);
    environment({ NODE_ENV: 'production', JWT_SECRET: STRONG, MAIL_SECRET: PLACEHOLDER });
    expect(() => resolveMailSecret({ exit: false })).toThrow(/MAIL_SECRET is a placeholder/);
  });

  it('uses a strong MAIL_SECRET, or falls back to the signing key', () => {
    environment({ NODE_ENV: 'production', JWT_SECRET: STRONG, MAIL_SECRET: `${STRONG}-mail` });
    expect(resolveMailSecret({ exit: false })).toBe(`${STRONG}-mail`);
    environment({ NODE_ENV: 'production', JWT_SECRET: STRONG });
    expect(resolveMailSecret({ exit: false })).toBe(STRONG);
  });
});

describe('the real start-up path', () => {
  // Loading the auth middleware resolves the key, as `node src/index.js` does
  // before it opens a port. It exits on its own when it refuses; a load that
  // succeeds is ended here, so a timer some module leaves running cannot hold
  // the test until it times out.
  const load = env => spawnSync(process.execPath, ['-e', "require('./src/middleware/auth'); process.exit(0)"], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, ...env },
  });

  it('exits 1 in production with the placeholder key', () => {
    const result = load({ NODE_ENV: 'production', JWT_SECRET: PLACEHOLDER });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/FATAL: JWT_SECRET is a placeholder/);
  });

  it('loads in production with a real key', () => {
    const result = load({ NODE_ENV: 'production', JWT_SECRET: STRONG });
    expect(result.status).toBe(0);
  });
});
