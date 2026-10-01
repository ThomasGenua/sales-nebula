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
async function start() {
  assertTestDatabase();
  const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%'`;
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map(t => '"' + t.tablename.replace(/"/g, '""') + '"').join(', ')} RESTART IDENTITY CASCADE`);
  await bootstrapAdmin(prisma, { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' });
  const role = await prisma.role.findUnique({ where: { name: 'Read Only' } });
  await prisma.user.upsert({ where: { email: 'pilot-reader@example.com' }, update: {}, create: {
    email: 'pilot-reader@example.com', password: await bcrypt.hash('Pilot-reader-123!', 10), firstName: 'Reader', lastName: 'Test', roleId: role.id,
  } });
  const app = express();
  // Test harness only; never mounted by the production app.
  app.get('/__test/mail', (req, res) => res.json(messages));
  app.use(createApp(prisma));
  await new Promise(resolve => smtp.listen(2526, '127.0.0.1', resolve));
  server = app.listen(7545, '127.0.0.1', () => console.log('Browser test API ready.'));
}
async function stop() {
  server?.close(); smtp.close(); await prisma.$disconnect(); process.exit(0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
start().catch(err => { console.error(err.message); process.exit(1); });
