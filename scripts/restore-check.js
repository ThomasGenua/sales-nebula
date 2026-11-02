#!/usr/bin/env node
// Restore a trusted pg_dump .sql.gz into an EMPTY disposable database only.
require('dotenv').config();
const fs = require('fs');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createGunzip } = require('zlib');
const { PrismaClient } = require('@prisma/client');

function target(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Set RESTORE_DATABASE_URL to an empty disposable PostgreSQL database'); }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !/^[a-z0-9_]*restore_test[a-z0-9_]*$/i.test(name)) throw new Error('Restore target database name must contain restore_test');
  if (process.env.DATABASE_URL) {
    const source = new URL(process.env.DATABASE_URL);
    if (source.hostname === parsed.hostname && (source.port || '5432') === (parsed.port || '5432') && decodeURIComponent(source.pathname) === decodeURIComponent(parsed.pathname)) throw new Error('Restore target must differ from DATABASE_URL');
  }
  return { args: ['-h', parsed.hostname, '-p', parsed.port || '5432', '-U', decodeURIComponent(parsed.username), '-d', name], password: decodeURIComponent(parsed.password) };
}
async function main() {
  const file = process.argv[2];
  if (!file || !file.endsWith('.sql.gz') || !fs.statSync(file).isFile()) throw new Error('Usage: node scripts/restore-check.js TRUSTED_BACKUP.sql.gz');
  const connection = target(process.env.RESTORE_DATABASE_URL);
  const db = new PrismaClient({ datasources: { db: { url: process.env.RESTORE_DATABASE_URL } } });
  try {
    const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`;
    if (tables.length) throw new Error('Restore target is not empty; refusing to overwrite it. Create a new restore_test database.');
    const child = spawn('psql', [...connection.args, '-X', '--set', 'ON_ERROR_STOP=1', '--single-transaction'], { env: { ...process.env, PGPASSWORD: connection.password }, stdio: ['pipe', 'ignore', 'pipe'], timeout: 300000, windowsHide: true });
    child.stderr.resume(); // Never echo SQL data or connection diagnostics from a backup.
    const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Restore failed (exit ${code}). Check the trusted backup and PostgreSQL versions; target remains disposable.`))); });
    const outcomes = await Promise.allSettled([completed, pipeline(fs.createReadStream(file), createGunzip(), child.stdin)]);
    const failure = outcomes.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
    const [users, contacts, deals, quotes, migrations] = await Promise.all([db.user.count(), db.contact.count(), db.deal.count(), db.quote.count(), db.$queryRaw`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`]);
    console.log(JSON.stringify({ restored: true, users, contacts, deals, quotes, appliedMigrations: migrations[0].count }));
    console.log('Restore completed in the disposable target. Verify schema drift and expected fixture counts before removing that database.');
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { target };
