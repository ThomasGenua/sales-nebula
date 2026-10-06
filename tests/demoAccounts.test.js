/**
 * The start-up check for demo accounts that still take the README's password.
 * Installs made before the production bootstrap ran the demo seed, so they have
 * an administrator anyone who has read the README can sign in as.
 */
const bcrypt = require('bcryptjs');
const { setup, teardown, cleanDatabase, createTestRole } = require('./setup');
const { openDemoAccounts, DEMO_EMAILS, DEMO_PASSWORD } = require('../src/services/demoAccounts');

let prisma, roleId;

beforeAll(async () => {
  ({ prisma } = await setup());
  await cleanDatabase();
  roleId = (await createTestRole('Admin')).id;
});

afterAll(async () => { await teardown(); });

const makeUser = async (email, password, active = true) => prisma.user.create({
  data: { email, password: await bcrypt.hash(password, 4), firstName: 'Demo', lastName: 'User', roleId, active },
});

test('names the active demo accounts that still take the published password, and only those', async () => {
  expect(await openDemoAccounts(prisma)).toEqual([]);

  await makeUser(DEMO_EMAILS[0], DEMO_PASSWORD);                 // still open
  await makeUser(DEMO_EMAILS[1], 'A-different-Passw0rd!');       // changed
  await makeUser(DEMO_EMAILS[2], DEMO_PASSWORD, false);          // deactivated
  await makeUser('someone@example.com', DEMO_PASSWORD);          // not a demo account

  expect(await openDemoAccounts(prisma)).toEqual([DEMO_EMAILS[0]]);
});

test('the seed creates its demo accounts with the password the check looks for', () => {
  const seed = require('fs').readFileSync(require.resolve('../prisma/seed.js'), 'utf8');
  expect(seed).toMatch(/bcrypt\.hash\(DEMO_PASSWORD, 12\)/);
  for (const email of DEMO_EMAILS) expect(seed).toContain(`email: '${email}'`);
});
