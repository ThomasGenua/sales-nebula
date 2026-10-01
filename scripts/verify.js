require('dotenv').config();
const { spawnSync } = require('child_process');
const { assertTestDatabase } = require('../tests/setup');

function run(script, args, env = {}, cwd = process.cwd()) {
  const shown = args.map(arg => /^postgres(?:ql)?:\/\//.test(arg) ? arg.replace(/(:\/\/[^:]+:)[^@]*@/, '$1***@') : arg);
  console.log(`\nVerifying: ${script} ${shown.join(' ')}`);
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd, env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status})`);
}
try {
  assertTestDatabase();
  assertTestDatabase(process.env.MIGRATE_URL);
  if (!process.env.MIGRATE_URL || process.env.MIGRATE_URL === process.env.DATABASE_URL) throw new Error('Set MIGRATE_URL to a separate empty test database to verify production migrations.');
  const prisma = require.resolve('prisma/build/index.js');
  run(prisma, ['migrate', 'deploy'], { DATABASE_URL: process.env.MIGRATE_URL });
  run(prisma, ['migrate', 'diff', '--from-url', process.env.MIGRATE_URL, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
  run(prisma, ['migrate', 'deploy']);
  run('scripts/check-prisma-fields.js', ['src', 'prisma/seed.js', 'scripts']);
  // Local integration hooks open the whole CRM and clear its schema. Allow
  // slower desktops enough time for setup, while still failing stalled checks.
  run('scripts/test.js', ['--forceExit', '--detectOpenHandles', '--testTimeout=90000'], { TEST_SCHEMA_READY: 'true', JWT_SECRET: 'local-verification-only-session-key-with-more-than-32-characters', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '' });
  run(require('path').resolve('frontend/node_modules/vite/bin/vite.js'), ['build'], {}, require('path').resolve('frontend'));
  run(require.resolve('@playwright/test/cli'), ['test']);
  console.log('\nAll verification checks passed.');
} catch (err) { console.error(err.message); process.exitCode = 1; }
