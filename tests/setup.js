/**
 * Test Setup & Helpers
 * 
 * Creates an isolated test environment with a fresh database.
 * Provides helper functions for authentication, seeding, and cleanup.
 * 
 * Requires: DATABASE_URL set to a test database (or uses SQLite for CI).
 * Run: NODE_ENV=test npx jest --runInBand
 */

const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../src/app');
const { signToken } = require('../src/middleware/auth');
const bcrypt = require('bcryptjs');

let prisma;
let app;

// ─── LIFECYCLE ───

async function setup() {
  // Open registration is off by default and returns 403; the register and
  // password-policy specs are about what happens when it is switched on.
  process.env.ALLOW_OPEN_REGISTRATION = 'true';

  prisma = new PrismaClient();
  app = createApp(prisma);

  // Push schema to test DB (fresh tables)
  const { execSync } = require('child_process');
  try {
    execSync('npx prisma db push --force-reset --accept-data-loss', {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'pipe',
    });
  } catch (e) {
    console.warn('Prisma push failed (may already be up to date):', e.message);
  }

  return { prisma, app };
}

async function teardown() {
  if (prisma) await prisma.$disconnect();
}

const ORDERED_TABLES = [
    'DataSubjectRequest', 'ConsentHistory', 'ConsentRecord', 'EmailSuppression',
    'DuplicateRecord', 'DuplicateRule', 'ValidationRule', 'Reminder',
    'InboundEmailAttachment', 'InboundEmailMessage', 'EmailPollLog',
    'InboundRoutingRule', 'InboundEmailAccount',
    'ChatterMention', 'ChatterLike', 'ChatterComment', 'ChatterPost',
    'ApprovalStep', 'ApprovalRequest', 'ApprovalProcessStep', 'ApprovalProcess',
    'ReportSchedule', 'Report', 'ReportFolder',
    'ForecastItem', 'Forecast',
    'TerritoryRule', 'TerritoryAccount', 'TerritoryMember', 'Territory',
    'KnowledgeAttachment', 'KnowledgeArticle', 'KnowledgeCategory',
    'FormulaField',
    'TagAssignment', 'Tag', 'Note',
    'LeadScoringRule', 'AssignmentRule',
    'EmailSequenceEnrollment', 'EmailSequence',
    'SavedView', 'SlaPolicy',
    'WebhookLog', 'Webhook',
    'RecycleBinItem', 'ApiKey',
    'RecordShare', 'SharingRule', 'Currency',
    'ProductDiscountSchedule', 'DiscountTier', 'DiscountSchedule',
    'PricebookEntry', 'Pricebook', 'ProductBundleItem', 'ProductBundle',
    'WorkflowLog', 'Workflow',
    'DealStageHistory', 'DealLineItem',
    'InvoiceItem', 'Invoice', 'QuoteItem', 'Quote',
    'CampaignRecipient', 'TargetList', 'Campaign',
    'Document',
    'CaseComment', 'Case',
    'Email', 'EmailTemplate',
    'Activity',
    'Deal',
    // Lead was never truncated, so contacts it pointed at survived the clean
    // and the next suite's lookup by email could match a stale row. Anything
    // holding a foreign key to Lead has to go first.
    'CustomFieldValue', 'ProspectListEntry', 'ProspectList', 'Prospect',
    'Lead',
    'PersonAccount',
    'Contact',
    'Account',
    'Product',
    'CustomField',
    'AuditLog', 'Notification', 'AdminConfig',
    'Permission', 'User', 'Role',
  ];

async function cleanDatabase() {
  // One TRUNCATE across every table beats a hand-maintained list: the list had
  // drifted, so Lead, CalendarEvent and others were never cleared and rows
  // leaked between runs — a recurring-series test counted 4, then 12, then 20
  // occurrences of the same event. CASCADE makes delete order irrelevant.
  try {
    const rows = await prisma.$queryRaw`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%'
    `;
    if (rows.length) {
      const list = rows.map(r => `"${r.tablename}"`).join(', ');
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      return;
    }
  } catch (err) {
    // Not PostgreSQL, or TRUNCATE is unavailable — fall through to per-model
    // deletes in dependency order.
  }

  const tables = ORDERED_TABLES;
  for (const table of tables) {
    const model = prisma[table.charAt(0).toLowerCase() + table.slice(1)];
    if (model) {
      try { await model.deleteMany(); } catch (e) { /* table might not exist */ }
    }
  }
}

// ─── SEED HELPERS ───

async function createTestRole(name = 'Admin', permissions = []) {
  const role = await prisma.role.create({
    data: {
      name,
      description: `Test ${name} role`,
      permissions: {
        create: permissions.length > 0 ? permissions : [
          { module: 'contacts', level: 'full' },
          { module: 'leads', level: 'full' },
          { module: 'deals', level: 'full' },
          { module: 'accounts', level: 'full' },
          { module: 'activities', level: 'full' },
          { module: 'emails', level: 'full' },
          { module: 'cases', level: 'full' },
          { module: 'documents', level: 'full' },
          { module: 'campaigns', level: 'full' },
          { module: 'products', level: 'full' },
          { module: 'quotes', level: 'full' },
          { module: 'invoices', level: 'full' },
          { module: 'workflows', level: 'full' },
          { module: 'users', level: 'full' },
          { module: 'admin', level: 'full' },
          { module: 'settings', level: 'full' },
          { module: 'roles', level: 'full' },
          { module: 'reports', level: 'full' },
          { module: 'forecasts', level: 'full' },
          { module: 'territories', level: 'full' },
          { module: 'knowledge', level: 'full' },
          { module: 'chatter', level: 'full' },
          { module: 'formulas', level: 'full' },
          { module: 'approvals', level: 'full' },
          // Ten modules the routes guard were never granted, so every request
          // to them answered 403 — which is why the suites covering them were
          // skipped rather than fixed. tests/permissionCoverage.test.js keeps
          // this list honest against what requirePermission() actually asks for.
          { module: 'assets', level: 'full' },
          { module: 'contracts', level: 'full' },
          { module: 'entitlements', level: 'full' },
          { module: 'fieldService', level: 'full' },
          { module: 'orders', level: 'full' },
          { module: 'partners', level: 'full' },
          { module: 'personAccounts', level: 'full' },
          { module: 'projects', level: 'full' },
          { module: 'subscriptions', level: 'full' },
          { module: 'surveys', level: 'full' },
        ],
      },
    },
  });
  return role;
}

async function createTestUser(overrides = {}) {
  let role;
  if (overrides.roleId) {
    role = { id: overrides.roleId };
  } else {
    // Find existing or create
    role = await prisma.role.findFirst({ where: { name: 'Admin' } });
    if (!role) role = await createTestRole();
  }

  const password = await bcrypt.hash(overrides.password || 'Test123!@', 10);
  const user = await prisma.user.create({
    data: {
      email: overrides.email || `test-${Date.now()}@test.com`,
      password,
      firstName: overrides.firstName || 'Test',
      lastName: overrides.lastName || 'User',
      roleId: role.id,
      active: overrides.active !== undefined ? overrides.active : true,
    },
    include: { role: { include: { permissions: true } } },
  });

  const token = signToken(user.id, user.role.name);
  return { user, token };
}

async function createTestAccount(overrides = {}) {
  return prisma.account.create({
    data: {
      name: overrides.name || `Test Account ${Date.now()}`,
      industry: overrides.industry || 'Technology',
      type: overrides.type || 'Customer',
      ...overrides,
    },
  });
}

async function createTestContact(overrides = {}) {
  return prisma.contact.create({
    data: {
      firstName: overrides.firstName || 'John',
      lastName: overrides.lastName || `Test-${Date.now()}`,
      email: overrides.email || `contact-${Date.now()}@test.com`,
      ...overrides,
    },
  });
}

async function createTestDeal(ownerId, overrides = {}) {
  return prisma.deal.create({
    data: {
      name: overrides.name || `Deal ${Date.now()}`,
      value: overrides.value || 50000,
      stage: overrides.stage || 'Qualification',
      probability: overrides.probability || 25,
      closeDate: overrides.closeDate || new Date(Date.now() + 30 * 86400000),
      ownerId,
      ...overrides,
    },
  });
}

async function createTestLead(overrides = {}) {
  return prisma.lead.create({
    data: {
      firstName: overrides.firstName || 'Jane',
      lastName: overrides.lastName || `Lead-${Date.now()}`,
      email: overrides.email || `lead-${Date.now()}@test.com`,
      company: overrides.company || 'Test Corp',
      status: overrides.status || 'New',
      ...overrides,
    },
  });
}

async function createTestProduct(overrides = {}) {
  const { code, ...rest } = overrides;
  return prisma.product.create({
    data: {
      name: rest.name || `Product ${Date.now()}`,
      sku: rest.sku || code || `PRD-${Date.now()}`,
      price: rest.price || 99.99,
      category: rest.category || 'Software',
      active: true,
      ...rest,
    },
  });
}

async function createTestCase(overrides = {}) {
  const count = await prisma.case.count();
  return prisma.case.create({
    data: {
      caseNumber: `CS-${String(count + 1).padStart(5, '0')}`,
      subject: overrides.subject || `Test Case ${Date.now()}`,
      status: overrides.status || 'New',
      priority: overrides.priority || 'Medium',
      ...overrides,
    },
  });
}

// ─── REQUEST HELPER ───

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

module.exports = {
  setup,
  teardown,
  cleanDatabase,
  createTestRole,
  createTestUser,
  createTestAccount,
  createTestContact,
  createTestDeal,
  createTestLead,
  createTestProduct,
  createTestCase,
  authHeader,
  getApp: () => app,
  getPrisma: () => prisma,
};
