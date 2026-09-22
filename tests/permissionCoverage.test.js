/**
 * The Admin role the suite builds must cover every module the routes guard.
 *
 * Ten modules — projects, assets, contracts, entitlements, fieldService,
 * orders, partners, personAccounts, subscriptions, surveys — were guarded by
 * requirePermission() but never granted, so every request to them answered 403.
 * The suites covering them were skipped rather than fixed, so nothing noticed.
 */

const fs = require('fs');
const path = require('path');
const { setup, teardown, cleanDatabase, createTestRole } = require('./setup');

const root = path.join(__dirname, '..');

/** Every module name passed to requirePermission() anywhere in the routes. */
function guardedModules() {
  const found = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'generated') walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/requirePermission\(\s*'([a-zA-Z]+)'/g)) found.add(m[1]);
    }
  };
  walk(path.join(root, 'src'));
  return [...found].sort();
}

let prisma;

beforeAll(async () => { ({ prisma } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => { await cleanDatabase(); });

describe('Test role permission coverage', () => {
  it('grants every module the routes guard', async () => {
    const role = await createTestRole('Admin');
    const granted = await prisma.permission.findMany({ where: { roleId: role.id }, select: { module: true } });
    const grantedNames = new Set(granted.map(p => p.module));

    const missing = guardedModules().filter(m => !grantedNames.has(m));
    expect(missing).toEqual([]);
  });

  it('finds a non-trivial number of guarded modules, so the scan is working', () => {
    expect(guardedModules().length).toBeGreaterThan(20);
  });
});
