/**
 * The demo accounts prisma/seed.js creates, and whether any still opens with
 * the password the README prints.
 *
 * Until the production bootstrap (scripts/bootstrap-admin.js) replaced it,
 * `docker compose up` ran the demo seed on a fresh install, so a deployment
 * made from those instructions has an administrator, a manager and a rep that
 * anyone who has read the README can sign in as. New installs no longer get
 * them; existing ones are told at start-up.
 */
const bcrypt = require('bcryptjs');

const DEMO_EMAILS = ['thomas@salesnebula.com', 'alex@salesnebula.com', 'sam@salesnebula.com'];
const DEMO_PASSWORD = 'password123';

/** The demo accounts that are active and still take the published password. */
async function openDemoAccounts(prisma) {
  const users = await prisma.user.findMany({
    where: { email: { in: DEMO_EMAILS }, active: true },
    select: { email: true, password: true },
  });
  const open = [];
  for (const user of users) {
    if (user.password && await bcrypt.compare(DEMO_PASSWORD, user.password)) open.push(user.email);
  }
  return open.sort();
}

module.exports = { openDemoAccounts, DEMO_EMAILS, DEMO_PASSWORD };
