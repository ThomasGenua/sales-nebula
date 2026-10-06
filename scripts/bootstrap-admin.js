require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { bootstrapAdmin } = require('../src/services/bootstrap');

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await bootstrapAdmin(prisma, {
      email: process.env.INITIAL_ADMIN_EMAIL, password: process.env.INITIAL_ADMIN_PASSWORD,
      firstName: process.env.INITIAL_ADMIN_FIRST_NAME, lastName: process.env.INITIAL_ADMIN_LAST_NAME,
    });
    console.log(result.created ? 'Initial administrator created. Sign in at /login.' : 'Accounts already exist; administrator bootstrap skipped.');
  } finally { await prisma.$disconnect(); }
}

main().catch(err => { console.error('Administrator bootstrap failed:', err.message); process.exitCode = 1; });
