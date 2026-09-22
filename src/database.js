const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PrismaClient: PostgresClient } = require('@prisma/client');
const { logger } = require('./services/logger');

const rootDir = path.join(__dirname, '..');
const sqliteSchema = path.join(rootDir, 'prisma', 'schema.sqlite.prisma');
const sqliteFile = path.join(rootDir, 'data', 'sales-nebula.sqlite');

function prismaLogOptions() {
  return process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];
}

/**
 * Local development may run on SQLite when PostgreSQL is missing. Production
 * does not, unless ALLOW_SQLITE_FALLBACK=true says so: an API that lost its
 * database for a moment used to come up on an empty SQLite file, serve an empty
 * CRM, and take writes the real database never saw. There it waits for
 * PostgreSQL instead, and exits if it never answers, so the supervisor
 * restarts it.
 */
function sqliteFallbackAllowed() {
  return process.env.NODE_ENV !== 'production' || process.env.ALLOW_SQLITE_FALLBACK === 'true';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tryPostgresOnce() {
  const client = new PostgresClient({ log: prismaLogOptions() });
  try {
    await Promise.race([
      client.$connect(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('PostgreSQL connection timed out')), 4000);
      }),
    ]);
    await client.$queryRaw`SELECT 1`;
    logger.info('Database: PostgreSQL');
    return client;
  } catch (error) {
    await client.$disconnect().catch(() => {});
    throw error;
  }
}

/** Connect, retrying with backoff (1s, 2s, 4s, ...) up to `attempts` times. */
async function tryPostgres({ attempts = 1 } = {}) {
  if (!process.env.DATABASE_URL) return null;
  for (let attempt = 1; ; attempt++) {
    try {
      return await tryPostgresOnce();
    } catch (error) {
      if (attempt >= attempts) {
        logger.warn({ error: error.message, attempts }, 'PostgreSQL unavailable');
        return null;
      }
      logger.warn({ error: error.message, attempt, attempts }, 'PostgreSQL unavailable; retrying');
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

function prepareSqlite() {
  fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
  process.env.SQLITE_DATABASE_URL = process.env.SQLITE_DATABASE_URL
    || `file:${sqliteFile.replace(/\\/g, '/')}`;

  if (!fs.existsSync(sqliteSchema)) {
    execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'generate-sqlite-schema.js')], {
      cwd: rootDir,
      stdio: 'inherit',
    });
  }

  const prismaCli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--schema', sqliteSchema, '--skip-generate'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
}

async function createDatabaseClient() {
  const fallback = sqliteFallbackAllowed();
  const attempts = fallback ? 1 : (parseInt(process.env.DB_CONNECT_ATTEMPTS, 10) || 5);
  const postgres = await tryPostgres({ attempts });
  if (postgres) return { prisma: postgres, provider: 'postgresql' };

  if (!fallback) {
    const reason = process.env.DATABASE_URL ? 'PostgreSQL is unreachable' : 'DATABASE_URL is not set';
    throw new Error(`${reason}. Refusing to start on the SQLite fallback in production; set ALLOW_SQLITE_FALLBACK=true to allow it.`);
  }
  logger.warn('Falling back to SQLite: this database is local to this machine and separate from PostgreSQL');
  prepareSqlite();
  const { PrismaClient: SqliteClient } = require('./generated/sqlite-client');
  const prisma = new SqliteClient({
    datasourceUrl: process.env.SQLITE_DATABASE_URL,
    log: prismaLogOptions(),
  });
  await prisma.$connect();
  logger.info({ file: sqliteFile }, 'Database: SQLite fallback');
  return { prisma, provider: 'sqlite' };
}

module.exports = { createDatabaseClient, sqliteFallbackAllowed };
