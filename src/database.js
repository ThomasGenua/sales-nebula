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

async function tryPostgres() {
  if (!process.env.DATABASE_URL) return null;

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
    logger.warn({ error: error.message }, 'PostgreSQL unavailable; falling back to SQLite');
    await client.$disconnect().catch(() => {});
    return null;
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
  const postgres = await tryPostgres();
  if (postgres) return { prisma: postgres, provider: 'postgresql' };

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

module.exports = { createDatabaseClient };
