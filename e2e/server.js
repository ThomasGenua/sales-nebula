// A real API and PostgreSQL, with mail captured locally. No customer mail leaves.
const { SMTPServer } = require('smtp-server');
const { PrismaClient } = require('@prisma/client');
const { assertTestDatabase } = require('../tests/setup');
const { bootstrapAdmin } = require('../src/services/bootstrap');
const { createApp } = require('../src/app');
const bcrypt = require('bcryptjs');
const express = require('express');

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '2526';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.MAIL_FROM = 'test@salesnebula.example';
const prisma = new PrismaClient();
const messages = [];
let server;
let api;
const claude = require('../src/services/claude');
const originalComplete = claude.complete, originalConfigured = claude.isConfigured;
const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'], disableReverseLookup: true,
  onData(stream, session, done) {
    let content = ''; stream.on('data', chunk => { content += chunk.toString(); });
    stream.on('end', () => {
      if (content.includes('[reject-delivery]')) return done(new Error('Local SMTP rejection for browser test'));
      messages.push({ to: session.envelope.rcptTo.map(r => r.address), content }); done();
    });
  },
});
async function resetWorkspace() {
  claude.complete = originalComplete; claude.isConfigured = originalConfigured;
  assertTestDatabase();
  await api?.locals.eventLog?.flush();
  const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%'`;
  if (process.env.TEST_DELETE_CLEANUP === 'true') {
    // Same disposable-database safeguard as the integration harness; avoids
    // rebuilding hundreds of table/index files on slow Windows test disks.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(`DO $$ DECLARE t record; BEGIN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
        LOOP EXECUTE format('DELETE FROM public.%I', t.tablename); END LOOP;
      END $$`);
    }, { timeout: 180000 });
  } else {
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map(t => '"' + t.tablename.replace(/"/g, '""') + '"').join(', ')} RESTART IDENTITY CASCADE`);
  }
  await bootstrapAdmin(prisma, { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' });
  // Most journeys model a returning operator; the onboarding journey explicitly reopens setup.
  const operator = await prisma.user.findUnique({ where: { email: 'pilot-admin@example.com' } });
  await prisma.userOnboarding.upsert({ where: { userId: operator.id }, create: { userId: operator.id, dismissedAt: new Date() }, update: { dismissedAt: new Date() } });
  const role = await prisma.role.findUnique({ where: { name: 'Read Only' } });
  await prisma.user.upsert({ where: { email: 'pilot-reader@example.com' }, update: {}, create: {
    email: 'pilot-reader@example.com', password: await bcrypt.hash('Pilot-reader-123!', 10), firstName: 'Reader', lastName: 'Test', roleId: role.id,
  } });
  messages.length = 0;
  require('../src/middleware/rowSecurity').invalidateOrgWideDefaultCache();
  require('../src/middleware/rowSecurity').invalidateHierarchyCache();
  for (const email of ['pilot-admin@example.com', 'pilot-reader@example.com']) require('../src/middleware/auth').clearLoginAttempts(email);
}
async function start() {
  await resetWorkspace();
  const app = express();
  // Test harness only; never mounted by the production app.
  app.get('/__test/mail', (req, res) => res.json(messages));
  app.post('/__test/meeting-provider', (req, res) => {
    if (req.get('x-test-reset') !== 'local-browser-tests') return res.sendStatus(403);
    claude.isConfigured = () => true;
    claude.complete = async () => ({ truncated: false, text: JSON.stringify({ summary: 'The customer requested a proposal and a follow-up meeting.', tasks: [{ subject: 'Send the customer proposal', dueDate: null }, { subject: 'Arrange a follow-up meeting', dueDate: null }], nextStep: 'Send the customer proposal', nextStepDate: null }) });
    res.json({ ready: true });
  });
  app.post('/__test/reset', async (req, res, next) => {
    if (req.get('x-test-reset') !== 'local-browser-tests') return res.sendStatus(403);
    try { await resetWorkspace(); res.json({ ready: true }); } catch (e) { next(e); }
  });
  // The API event log, which tests leave off, for the Monitoring screen; its
  // rows written within half a second rather than five.
  api = createApp(prisma, { eventLog: { flushMs: 500 } });
  app.use(api);
  await new Promise(resolve => smtp.listen(2526, '127.0.0.1', resolve));
  server = app.listen(7545, '127.0.0.1', () => console.log('Browser test API ready.'));
}
async function stop() {
  server?.close(); smtp.close(); await prisma.$disconnect(); process.exit(0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
start().catch(err => { console.error(err.message); process.exit(1); });
