const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Sales Nebula database...\n');

  // ─── ROLES ───
  const modules = ['contacts', 'leads', 'deals', 'accounts', 'activities', 'emails', 'cases', 'documents', 'campaigns', 'products', 'quotes', 'invoices', 'workflows', 'users', 'roles', 'settings', 'admin', 'reports', 'forecasts', 'territories', 'knowledge', 'chatter', 'formulas', 'approvals'];

  const adminRole = await prisma.role.create({
    data: {
      name: 'Admin',
      description: 'Full access to all modules',
      permissions: { create: modules.map(m => ({ module: m, level: 'full' })) },
    },
  });

  const managerRole = await prisma.role.create({
    data: {
      name: 'Manager',
      description: 'Full CRM access, read-only admin',
      permissions: {
        create: modules.map(m => ({
          module: m,
          level: ['users', 'roles', 'settings', 'admin'].includes(m) ? 'read' : 'full',
        })),
      },
    },
  });

  const repRole = await prisma.role.create({
    data: {
      name: 'Sales Rep',
      description: 'Edit CRM data, limited admin',
      permissions: {
        create: modules.map(m => ({
          module: m,
          level: ['users', 'roles', 'settings'].includes(m) ? 'none' : ['products', 'invoices', 'workflows'].includes(m) ? 'read' : 'edit',
        })),
      },
    },
  });

  const readRole = await prisma.role.create({
    data: {
      name: 'Read Only',
      description: 'View all data, no edits',
      permissions: { create: modules.map(m => ({ module: m, level: 'read' })) },
    },
  });

  console.log('  Roles created: Admin, Manager, Sales Rep, Read Only');

  // ─── USERS ───
  const pw = await bcrypt.hash('password123', 12);

  const thomas = await prisma.user.create({ data: { email: 'thomas@salesnebula.com', password: pw, firstName: 'Thomas', lastName: 'Genua', avatar: 'TG', roleId: adminRole.id } });
  const alex = await prisma.user.create({ data: { email: 'alex@salesnebula.com', password: pw, firstName: 'Alex', lastName: 'Rivera', avatar: 'AR', roleId: managerRole.id } });
  const sam = await prisma.user.create({ data: { email: 'sam@salesnebula.com', password: pw, firstName: 'Sam', lastName: 'Patel', avatar: 'SP', roleId: repRole.id } });
  const jordan = await prisma.user.create({ data: { email: 'jordan@salesnebula.com', password: pw, firstName: 'Jordan', lastName: 'Lee', avatar: 'JL', roleId: repRole.id } });

  console.log('  Users created: Thomas (Admin), Alex (Manager), Sam (Rep), Jordan (Rep)');
  console.log('  Default password for staff: password123\n');

  // ─── ACCOUNTS ───
  const accts = await Promise.all([
    prisma.account.create({ data: { name: 'Acme Corporation', industry: 'Technology', type: 'Customer', revenue: 5000000, employees: 250, rating: 4, phone: '555-0100', website: 'acme.com' } }),
    prisma.account.create({ data: { name: 'Globex Industries', industry: 'Manufacturing', type: 'Prospect', revenue: 12000000, employees: 800, rating: 3, phone: '555-0200' } }),
    prisma.account.create({ data: { name: 'Stark Ventures', industry: 'Finance', type: 'Customer', revenue: 25000000, employees: 1200, rating: 5, phone: '555-0300' } }),
    prisma.account.create({ data: { name: 'Initech', industry: 'Technology', type: 'Partner', revenue: 800000, employees: 45, rating: 2, phone: '555-0400' } }),
    prisma.account.create({ data: { name: 'Pied Piper', industry: 'SaaS', type: 'Prospect', revenue: 2000000, employees: 65, rating: 4 } }),
    prisma.account.create({ data: { name: 'Hooli', industry: 'Technology', type: 'Customer', revenue: 50000000, employees: 5000, rating: 3 } }),
  ]);
  console.log('  6 accounts created');

  // ─── CONTACTS ───
  const contacts = await Promise.all([
    prisma.contact.create({ data: { firstName: 'Sarah', lastName: 'Chen', email: 'sarah@acme.com', phone: '555-1001', title: 'VP Sales', status: 'Active', source: 'Referral', accountId: accts[0].id } }),
    prisma.contact.create({ data: { firstName: 'Michael', lastName: 'Torres', email: 'michael@globex.com', phone: '555-1002', title: 'CTO', status: 'Active', source: 'LinkedIn', accountId: accts[1].id } }),
    prisma.contact.create({ data: { firstName: 'Emily', lastName: 'Zhang', email: 'emily@stark.com', phone: '555-1003', title: 'Director of Ops', status: 'Active', source: 'Trade Show', accountId: accts[2].id } }),
    prisma.contact.create({ data: { firstName: 'James', lastName: 'Wilson', email: 'james@initech.com', phone: '555-1004', title: 'CEO', status: 'Active', source: 'Cold Call', accountId: accts[3].id } }),
    prisma.contact.create({ data: { firstName: 'Lisa', lastName: 'Park', email: 'lisa@piedpiper.com', phone: '555-1005', title: 'Head of Product', status: 'Active', source: 'Website', accountId: accts[4].id } }),
    prisma.contact.create({ data: { firstName: 'David', lastName: 'Kim', email: 'david@hooli.com', phone: '555-1006', title: 'VP Engineering', status: 'Inactive', source: 'Referral', accountId: accts[5].id } }),
  ]);
  console.log('  6 contacts created');

  // ─── LEADS ───
  const leads = await Promise.all([
    prisma.lead.create({ data: { firstName: 'Anna', lastName: 'Martinez', email: 'anna@techstart.io', company: 'TechStart', source: 'Website', status: 'New', score: 85, value: 150000 } }),
    prisma.lead.create({ data: { firstName: 'Robert', lastName: 'Johnson', email: 'rjohnson@bigcorp.com', company: 'BigCorp', source: 'Trade Show', status: 'Contacted', score: 72, value: 300000 } }),
    prisma.lead.create({ data: { firstName: 'Sophie', lastName: 'Williams', email: 'sophie@innovate.co', company: 'Innovate Co', source: 'LinkedIn', status: 'Qualified', score: 91, value: 500000 } }),
    prisma.lead.create({ data: { firstName: 'Marcus', lastName: 'Brown', email: 'marcus@retail.com', company: 'RetailPlus', source: 'Referral', status: 'New', score: 45, value: 75000 } }),
    prisma.lead.create({ data: { firstName: 'Nina', lastName: 'Patel', email: 'nina@health.io', company: 'HealthTech', source: 'Cold Call', status: 'Contacted', score: 68, value: 200000 } }),
    prisma.lead.create({ data: { firstName: 'Alex', lastName: 'Thompson', email: 'alex@green.energy', company: 'GreenEnergy', source: 'Website', status: 'Contacted', score: 55, value: 120000 } }),
  ]);
  console.log('  6 leads created');

  // ─── DEALS ───
  const deals = await Promise.all([
    prisma.deal.create({ data: { name: 'Acme Enterprise License', stage: 'Negotiation', value: 250000, probability: 75, closeDate: new Date('2026-03-15'), ownerId: thomas.id, accountId: accts[0].id, contactId: contacts[0].id } }),
    prisma.deal.create({ data: { name: 'Globex Platform Migration', stage: 'Discovery', value: 180000, probability: 25, closeDate: new Date('2026-05-01'), ownerId: alex.id, accountId: accts[1].id, contactId: contacts[1].id } }),
    prisma.deal.create({ data: { name: 'Stark Analytics Suite', stage: 'Proposal', value: 500000, probability: 50, closeDate: new Date('2026-04-01'), ownerId: thomas.id, accountId: accts[2].id, contactId: contacts[2].id } }),
    prisma.deal.create({ data: { name: 'Initech Support Contract', stage: 'Closed Won', value: 45000, probability: 100, closeDate: new Date('2026-01-20'), ownerId: sam.id, accountId: accts[3].id, contactId: contacts[3].id } }),
    prisma.deal.create({ data: { name: 'Pied Piper Integration', stage: 'Proposal', value: 320000, probability: 40, closeDate: new Date('2026-06-01'), ownerId: alex.id, accountId: accts[4].id, contactId: contacts[4].id } }),
    prisma.deal.create({ data: { name: 'Hooli Cloud Migration', stage: 'Closed Lost', value: 750000, probability: 0, ownerId: thomas.id, accountId: accts[5].id, contactId: contacts[5].id } }),
  ]);
  console.log('  6 deals created');

  // ─── ACTIVITIES ───
  await Promise.all([
    prisma.activity.create({ data: { type: 'Call', subject: 'Follow up on proposal', date: new Date('2026-02-26'), priority: 'High', status: 'Scheduled', contactId: contacts[0].id, dealId: deals[0].id } }),
    prisma.activity.create({ data: { type: 'Meeting', subject: 'Quarterly review', date: new Date('2026-02-27') , priority: 'High', status: 'Scheduled', contactId: contacts[2].id, dealId: deals[2].id } }),
    prisma.activity.create({ data: { type: 'Email', subject: 'Send case study', date: new Date('2026-02-24'), priority: 'Medium', status: 'Completed', contactId: contacts[1].id, dealId: deals[1].id } }),
    prisma.activity.create({ data: { type: 'Task', subject: 'Prepare demo environment', date: new Date('2026-02-28'), priority: 'Medium', status: 'Pending', dealId: deals[4].id } }),
    prisma.activity.create({ data: { type: 'Call', subject: 'Discovery call with BigCorp', date: new Date('2026-03-01'), priority: 'High', status: 'Scheduled', contactId: contacts[3].id } }),
    prisma.activity.create({ data: { type: 'Meeting', subject: 'Contract negotiation', date: new Date('2026-02-25') , priority: 'High', status: 'Completed', contactId: contacts[0].id, dealId: deals[0].id } }),
    prisma.activity.create({ data: { type: 'Task', subject: 'Update CRM records', date: new Date('2026-02-23'), priority: 'Low', status: 'Completed' } }),
    prisma.activity.create({ data: { type: 'Email', subject: 'Welcome onboarding sequence', date: new Date('2026-02-22'), priority: 'Medium', status: 'Completed', contactId: contacts[3].id, dealId: deals[3].id } }),
  ]);
  console.log('  8 activities created');

  // ─── PRODUCTS ───
  const products = await Promise.all([
    prisma.product.create({ data: { name: 'Enterprise License', sku: 'ENT-001', category: 'License', price: 50000, cost: 5000, unit: 'year' } }),
    prisma.product.create({ data: { name: 'Professional License', sku: 'PRO-001', category: 'License', price: 25000, cost: 2500, unit: 'year' } }),
    prisma.product.create({ data: { name: 'Implementation Services', sku: 'SVC-001', category: 'Services', price: 15000, cost: 8000, unit: 'project' } }),
    prisma.product.create({ data: { name: 'Premium Support', sku: 'SUP-001', category: 'Support', price: 12000, cost: 4000, unit: 'year' } }),
    prisma.product.create({ data: { name: 'Custom Integration', sku: 'SVC-002', category: 'Services', price: 30000, cost: 18000, unit: 'project' } }),
    prisma.product.create({ data: { name: 'API Access', sku: 'ADD-001', category: 'Add-on', price: 5000, cost: 500, unit: 'year' } }),
    prisma.product.create({ data: { name: 'Data Migration', sku: 'SVC-003', category: 'Services', price: 8000, cost: 5000, unit: 'project' } }),
    prisma.product.create({ data: { name: 'Training Package', sku: 'SVC-004', category: 'Services', price: 3000, cost: 1500, unit: 'session' } }),
  ]);
  console.log('  8 products created');

  // ─── CASES ───
  const cases = await Promise.all([
    prisma.case.create({ data: { caseNumber: 'CS-001', subject: 'Login issues after update', type: 'Bug', status: 'Open', priority: 'High', contactId: contacts[0].id, accountId: accts[0].id, description: 'Users reporting intermittent login failures' } }),
    prisma.case.create({ data: { caseNumber: 'CS-002', subject: 'Feature request: Dark mode', type: 'Feature', status: 'New', priority: 'Low', contactId: contacts[2].id, description: 'Client requesting dark mode for dashboard' } }),
    prisma.case.create({ data: { caseNumber: 'CS-003', subject: 'Performance degradation', type: 'Problem', status: 'Escalated', priority: 'High', contactId: contacts[1].id, accountId: accts[1].id, dealId: deals[1].id, description: 'System slowing down during peak hours' } }),
    prisma.case.create({ data: { caseNumber: 'CS-004', subject: 'Billing discrepancy', type: 'Problem', status: 'Resolved', priority: 'Medium', contactId: contacts[3].id, accountId: accts[3].id, resolution: 'Credit applied to next invoice' } }),
    prisma.case.create({ data: { caseNumber: 'CS-005', subject: 'API rate limit questions', type: 'Question', status: 'Open', priority: 'Medium', contactId: contacts[4].id, description: 'Need clarification on rate limits for integration' } }),
  ]);
  console.log('  5 cases created');

  // ─── CASE COMMENTS ───
  await Promise.all([
    prisma.caseComment.create({ data: { caseId: cases[0].id, authorId: thomas.id, text: 'Investigating the login issue. Appears related to session token expiry.' } }),
    prisma.caseComment.create({ data: { caseId: cases[0].id, authorId: sam.id, text: 'Confirmed - the JWT refresh is failing for some users. Deploying fix.' } }),
    prisma.caseComment.create({ data: { caseId: cases[2].id, authorId: alex.id, text: 'Running diagnostics on the database queries. Suspect N+1 issue.' } }),
    prisma.caseComment.create({ data: { caseId: cases[2].id, authorId: thomas.id, text: 'Escalating to engineering team. This is blocking the Globex migration.' } }),
  ]);
  console.log('  4 case comments created');

  // ─── WORKFLOWS ───
  await Promise.all([
    prisma.workflow.create({ data: { name: 'High-Value Lead Alert', module: 'leads', trigger: 'create', conditions: [{ field: 'value', operator: 'greaterThan', value: '100000' }], actions: [{ type: 'createNotification', config: { title: 'High-Value Lead', message: 'New lead worth over $100K' } }], active: true } }),
    prisma.workflow.create({ data: { name: 'Deal Won Celebration', module: 'deals', trigger: 'statusChange', conditions: [{ field: 'stage', operator: 'equals', value: 'Closed Won' }], actions: [{ type: 'createActivity', config: { actType: 'Task', subject: 'Send thank-you gift', priority: 'Medium' } }, { type: 'createNotification', config: { title: 'Deal Won!', message: 'Congratulations on closing the deal' } }], active: true } }),
    prisma.workflow.create({ data: { name: 'Deal Lost Follow-up', module: 'deals', trigger: 'statusChange', conditions: [{ field: 'stage', operator: 'equals', value: 'Closed Lost' }], actions: [{ type: 'createActivity', config: { actType: 'Task', subject: 'Post-mortem analysis', priority: 'High' } }], active: true } }),
  ]);
  console.log('  3 workflows created');

  // ─── EMAIL TEMPLATES ───
  await Promise.all([
    prisma.emailTemplate.create({ data: { name: 'Introduction', subject: 'Introduction from Sales Nebula', body: 'Hi {{firstName}},\n\nI wanted to reach out and introduce myself...' } }),
    prisma.emailTemplate.create({ data: { name: 'Follow Up', subject: 'Following up - {{company}}', body: 'Hi {{firstName}},\n\nI wanted to follow up on our recent conversation...' } }),
    prisma.emailTemplate.create({ data: { name: 'Proposal', subject: 'Proposal for {{company}}', body: 'Hi {{firstName}},\n\nPlease find attached our proposal...' } }),
  ]);
  console.log('  3 email templates created');

  // ─── CUSTOM FIELDS ───
  await Promise.all([
    prisma.customField.create({ data: { name: 'LinkedIn', module: 'contacts', fieldKey: 'cf_linkedin', type: 'url' } }),
    prisma.customField.create({ data: { name: 'Timezone', module: 'contacts', fieldKey: 'cf_timezone', type: 'select', options: 'EST,CST,MST,PST,UTC,GMT' } }),
    prisma.customField.create({ data: { name: 'Deal Source', module: 'deals', fieldKey: 'cf_deal_source', type: 'select', options: 'Inbound,Outbound,Partner,Existing' } }),
    prisma.customField.create({ data: { name: 'SLA Tier', module: 'accounts', fieldKey: 'cf_sla_tier', type: 'select', options: 'Gold,Silver,Bronze' } }),
  ]);
  console.log('  4 custom fields created');

  // ─── ADMIN CONFIG ───
  await Promise.all([
    prisma.adminConfig.create({ data: { key: 'companyName', value: 'Sales Nebula' } }),
    prisma.adminConfig.create({ data: { key: 'currency', value: 'USD' } }),
    prisma.adminConfig.create({ data: { key: 'dateFormat', value: 'YYYY-MM-DD' } }),
    prisma.adminConfig.create({ data: { key: 'timezone', value: 'America/New_York' } }),
    prisma.adminConfig.create({ data: { key: 'theme', value: 'nebula' } }),
  ]);
  console.log('  Admin config set');

  // ─── TERRITORIES ───
  const northAmerica = await prisma.territory.create({ data: { name: 'North America', region: 'NA', type: 'Sales' } });
  const westCoast = await prisma.territory.create({ data: { name: 'West Coast', region: 'NA-West', type: 'Sales' } });
  const eastCoast = await prisma.territory.create({ data: { name: 'East Coast', region: 'NA-East', type: 'Sales' } });
  const emea = await prisma.territory.create({ data: { name: 'EMEA', region: 'EU', type: 'Sales' } });

  await prisma.territoryMember.createMany({ data: [
    { territoryId: northAmerica.id, userId: thomas.id, role: 'Owner' },
    { territoryId: westCoast.id, userId: alex.id, role: 'Owner' },
    { territoryId: eastCoast.id, userId: sam.id, role: 'Owner' },
    { territoryId: emea.id, userId: jordan.id, role: 'Owner' },
  ]});

  await prisma.territoryAccount.createMany({ data: [
    { territoryId: westCoast.id, accountId: accts[0].id },
    { territoryId: westCoast.id, accountId: accts[4].id },
    { territoryId: eastCoast.id, accountId: accts[1].id },
    { territoryId: eastCoast.id, accountId: accts[2].id },
  ]});

  await prisma.territoryRule.createMany({ data: [
    { territoryId: westCoast.id, field: 'industry', operator: 'equals', value: 'SaaS' },
    { territoryId: eastCoast.id, field: 'revenue', operator: 'greaterThan', value: '10000000' },
  ]});
  console.log('  4 territories with hierarchy, members, accounts, and rules');

  // ─── FORECASTS ───
  const q1Forecast = await prisma.forecast.create({
    data: {
      name: 'Q1 2026 Forecast',
      period: 'Q1-2026',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-03-31'),
      userId: thomas.id,
      territoryId: northAmerica.id,
      quotaAmount: 500000,
      commit: 250000,
      bestCase: 430000,
      pipeline: 750000,
      closed: 45000,
      status: 'Open',
      items: {
        create: [
          { dealId: deals[0].id, amount: 250000, probability: 75, category: 'Commit', closeDate: new Date('2026-03-15') },
          { dealId: deals[2].id, amount: 500000, probability: 50, category: 'Best Case', closeDate: new Date('2026-04-01') },
          { dealId: deals[1].id, amount: 180000, probability: 25, category: 'Pipeline', closeDate: new Date('2026-05-01') },
        ],
      },
    },
  });
  console.log('  Q1 2026 forecast with 3 items');

  // ─── CPQ ───
  const stdPricebook = await prisma.pricebook.create({
    data: {
      name: 'Standard Price Book',
      isStandard: true,
      currency: 'USD',
      entries: {
        create: products.map(p => ({ productId: p.id, unitPrice: p.price })),
      },
    },
  });

  const entPricebook = await prisma.pricebook.create({
    data: {
      name: 'Enterprise Price Book',
      currency: 'USD',
      description: '10% discount for enterprise customers',
      entries: {
        create: products.map(p => ({ productId: p.id, unitPrice: p.price * 0.9 })),
      },
    },
  });

  const starterBundle = await prisma.productBundle.create({
    data: {
      name: 'Starter Bundle',
      description: 'License + Implementation + Support',
      discount: 15,
      items: {
        create: [
          { productId: products[1].id, quantity: 1, required: true, sortOrder: 1 },
          { productId: products[2].id, quantity: 1, required: true, sortOrder: 2 },
          { productId: products[3].id, quantity: 1, required: false, sortOrder: 3 },
        ],
      },
    },
  });

  const volumeDiscount = await prisma.discountSchedule.create({
    data: {
      name: 'Volume Discount',
      type: 'volume',
      tiers: {
        create: [
          { minQty: 1, maxQty: 4, discount: 0, sortOrder: 1 },
          { minQty: 5, maxQty: 9, discount: 5, sortOrder: 2 },
          { minQty: 10, maxQty: 24, discount: 10, sortOrder: 3 },
          { minQty: 25, maxQty: null, discount: 15, sortOrder: 4 },
        ],
      },
    },
  });
  console.log('  CPQ: 2 pricebooks, 1 bundle, 1 discount schedule');

  // ─── APPROVAL PROCESSES ───
  const dealApproval = await prisma.approvalProcess.create({
    data: {
      name: 'High-Value Deal Approval',
      description: 'Requires manager approval for deals over $100K',
      module: 'deals',
      entryConditions: [{ field: 'value', operator: 'greaterThan', value: '100000' }],
      finalApprovalAction: 'updateField',
      finalApprovalConfig: { field: 'stage', value: 'Negotiation' },
      steps: {
        create: [
          { stepNumber: 1, name: 'Manager Review', approverType: 'user', approverId: alex.id },
          { stepNumber: 2, name: 'VP Approval', approverType: 'user', approverId: thomas.id },
        ],
      },
    },
  });

  const discountApproval = await prisma.approvalProcess.create({
    data: {
      name: 'Discount Approval',
      description: 'Approval required for discounts over 20%',
      module: 'quotes',
      entryConditions: [{ field: 'discount', operator: 'greaterThan', value: '20' }],
      steps: {
        create: [
          { stepNumber: 1, name: 'Sales Manager', approverType: 'user', approverId: alex.id },
        ],
      },
    },
  });
  console.log('  2 approval processes (deal + discount)');

  // ─── KNOWLEDGE BASE ───
  const kbCategories = await Promise.all([
    prisma.knowledgeCategory.create({ data: { name: 'Getting Started', description: 'Onboarding and setup guides', sortOrder: 1 } }),
    prisma.knowledgeCategory.create({ data: { name: 'Troubleshooting', description: 'Common issues and solutions', sortOrder: 2 } }),
    prisma.knowledgeCategory.create({ data: { name: 'Best Practices', description: 'Tips and recommendations', sortOrder: 3 } }),
    prisma.knowledgeCategory.create({ data: { name: 'API Reference', description: 'Technical documentation', sortOrder: 4 } }),
  ]);

  await Promise.all([
    prisma.knowledgeArticle.create({ data: {
      title: 'Getting Started with Sales Nebula',
      slug: 'getting-started',
      body: '# Welcome to Sales Nebula\n\nThis guide will walk you through setting up your CRM for the first time.\n\n## Step 1: Configure Your Profile\nNavigate to Settings and update your company information.\n\n## Step 2: Import Your Data\nUse the CSV import tool to bring in existing contacts and leads.\n\n## Step 3: Set Up Workflows\nAutomate common tasks with our workflow engine.',
      summary: 'A complete guide to setting up your Sales Nebula CRM',
      category: 'Getting Started',
      status: 'Published',
      visibility: 'Public',
      authorId: thomas.id,
      tags: ['onboarding', 'setup', 'beginner'],
      viewCount: 156,
      helpfulYes: 42,
      helpfulNo: 3,
    }}),
    prisma.knowledgeArticle.create({ data: {
      title: 'Troubleshooting Login Issues',
      slug: 'troubleshooting-login',
      body: '# Login Troubleshooting\n\nIf you are experiencing issues logging in, try these steps:\n\n1. Clear your browser cache\n2. Ensure your password meets requirements\n3. Check if your account is active\n4. Contact your administrator',
      summary: 'Steps to resolve common login problems',
      category: 'Troubleshooting',
      status: 'Published',
      visibility: 'Public',
      authorId: thomas.id,
      tags: ['login', 'authentication', 'troubleshooting'],
      viewCount: 89,
      helpfulYes: 28,
      helpfulNo: 5,
    }}),
    prisma.knowledgeArticle.create({ data: {
      title: 'Deal Management Best Practices',
      slug: 'deal-best-practices',
      body: '# Deal Management\n\nFollow these best practices for managing your sales pipeline effectively.\n\n## Keep Stages Updated\nMove deals through stages as conversations progress.\n\n## Set Realistic Close Dates\nBase dates on buyer signals, not wishful thinking.\n\n## Use the AI Coach\nLeverage the AI deal coach for personalized recommendations.',
      summary: 'Best practices for managing your sales pipeline',
      category: 'Best Practices',
      status: 'Published',
      visibility: 'Internal',
      authorId: alex.id,
      tags: ['deals', 'pipeline', 'sales'],
      viewCount: 67,
      helpfulYes: 19,
    }}),
    prisma.knowledgeArticle.create({ data: {
      title: 'API Authentication Guide',
      slug: 'api-authentication',
      body: '# API Authentication\n\nAll API requests require a Bearer token obtained from the login endpoint.\n\n```\nPOST /api/auth/login\n{ "email": "...", "password": "..." }\n```\n\nInclude the token in subsequent requests:\n```\nAuthorization: Bearer <token>\n```',
      summary: 'How to authenticate with the Sales Nebula API',
      category: 'API Reference',
      status: 'Draft',
      visibility: 'Internal',
      authorId: thomas.id,
      tags: ['api', 'authentication', 'developer'],
    }}),
  ]);
  console.log('  4 knowledge categories, 4 articles');

  // ─── CHATTER ───
  const post1 = await prisma.chatterPost.create({ data: {
    body: 'Just closed the Initech support contract! Great teamwork everyone.',
    authorId: sam.id,
  }});
  await prisma.chatterComment.create({ data: { body: 'Congrats Sam! Well deserved.', postId: post1.id, authorId: thomas.id } });
  await prisma.chatterComment.create({ data: { body: 'Nice work! What was the final value?', postId: post1.id, authorId: alex.id } });

  const post2 = await prisma.chatterPost.create({ data: {
    body: 'Reminder: Q1 forecasts are due by end of week. Please submit yours in the Forecasting module.',
    authorId: thomas.id,
    pinned: true,
  }});

  const post3 = await prisma.chatterPost.create({ data: {
    body: 'Had a great discovery call with Pied Piper today. They are very interested in our integration capabilities.',
    authorId: alex.id[4].id,
  }});
  console.log('  3 chatter posts with comments');

  // ─── FORMULA FIELDS ───
  await Promise.all([
    prisma.formulaField.create({ data: {
      name: 'Weighted Value',
      fieldKey: 'ff_weighted_value',
      module: 'deals',
      returnType: 'currency',
      formula: 'value * probability / 100',
    }}),
    prisma.formulaField.create({ data: {
      name: 'Days Open',
      fieldKey: 'ff_days_open',
      module: 'deals',
      returnType: 'number',
      formula: 'DATEDIFF(NOW(), createdAt)',
    }}),
    prisma.formulaField.create({ data: {
      name: 'Margin %',
      fieldKey: 'ff_margin_pct',
      module: 'products',
      returnType: 'percent',
      formula: 'ROUND((price - cost) / price * 100, 1)',
      precision: 1,
    }}),
    prisma.formulaField.create({ data: {
      name: 'Full Name',
      fieldKey: 'ff_full_name',
      module: 'contacts',
      returnType: 'text',
      formula: 'CONCAT(firstName, " ", lastName)',
    }}),
    prisma.formulaField.create({ data: {
      name: 'Is High Priority',
      fieldKey: 'ff_high_priority',
      module: 'cases',
      returnType: 'boolean',
      formula: 'priority == "High"',
    }}),
  ]);
  console.log('  5 formula fields');

  // ─── REPORTS & FOLDERS ───
  const salesFolder = await prisma.reportFolder.create({ data: { name: 'Sales Reports' } });
  const opsFolder = await prisma.reportFolder.create({ data: { name: 'Operations' } });

  await Promise.all([
    prisma.report.create({ data: {
      name: 'Pipeline by Stage',
      description: 'Deal count and total value grouped by stage',
      module: 'deals',
      reportType: 'chart',
      chartType: 'bar',
      columns: [{ field: 'name', label: 'Deal Name' }, { field: 'value', label: 'Value' }, { field: 'stage', label: 'Stage' }],
      filters: [{ field: 'stage', operator: 'not_equals', value: 'Closed Lost' }],
      groupBy: ['stage'],
      aggregations: [{ field: 'value', function: 'sum' }, { field: 'id', function: 'count' }],
      sortBy: [{ field: 'value', direction: 'desc' }],
      isPublic: true,
      folderId: salesFolder.id,
      createdById: users[0].id,
    }}),
    prisma.report.create({ data: {
      name: 'Contacts by Source',
      description: 'Where our contacts are coming from',
      module: 'contacts',
      reportType: 'chart',
      chartType: 'pie',
      columns: [{ field: 'firstName', label: 'Name' }, { field: 'email', label: 'Email' }, { field: 'source', label: 'Source' }],
      filters: [],
      groupBy: ['source'],
      aggregations: [{ field: 'id', function: 'count' }],
      isPublic: true,
      folderId: salesFolder.id,
      createdById: users[0].id,
    }}),
    prisma.report.create({ data: {
      name: 'Open Cases by Priority',
      description: 'Active support cases breakdown',
      module: 'cases',
      reportType: 'summary',
      columns: [{ field: 'caseNumber', label: 'Case #' }, { field: 'subject', label: 'Subject' }, { field: 'priority', label: 'Priority' }, { field: 'status', label: 'Status' }],
      filters: [{ field: 'status', operator: 'not_in', value: ['Closed'] }],
      groupBy: ['priority'],
      aggregations: [{ field: 'id', function: 'count' }],
      isPublic: true,
      folderId: opsFolder.id,
      createdById: users[0].id,
    }}),
    prisma.report.create({ data: {
      name: 'Revenue by Account',
      description: 'Total closed deal value per account',
      module: 'deals',
      reportType: 'summary',
      columns: [{ field: 'name', label: 'Deal' }, { field: 'value', label: 'Value' }, { field: 'stage', label: 'Stage' }],
      filters: [{ field: 'stage', operator: 'equals', value: 'Closed Won' }],
      groupBy: [],
      aggregations: [{ field: 'value', function: 'sum' }, { field: 'value', function: 'avg' }],
      isPublic: true,
      folderId: salesFolder.id,
      createdById: users[0].id,
    }}),
    prisma.report.create({ data: {
      name: 'Leads This Month',
      description: 'All leads created in the current month',
      module: 'leads',
      reportType: 'tabular',
      columns: [{ field: 'firstName', label: 'First Name' }, { field: 'lastName', label: 'Last Name' }, { field: 'company', label: 'Company' }, { field: 'status', label: 'Status' }, { field: 'score', label: 'Score' }],
      filters: [{ field: 'createdAt', operator: 'this_month', value: null }],
      sortBy: [{ field: 'createdAt', direction: 'desc' }],
      isPublic: false,
      createdById: users[0].id,
    }}),
  ]);
  console.log('  5 reports in 2 folders');

  // ─── TAGS ───
  const tags = await Promise.all([
    prisma.tag.create({ data: { name: 'VIP', color: '#FFD700' } }),
    prisma.tag.create({ data: { name: 'Hot Lead', color: '#FF4444' } }),
    prisma.tag.create({ data: { name: 'Partner', color: '#4444FF' } }),
    prisma.tag.create({ data: { name: 'Enterprise', color: '#44AA44' } }),
    prisma.tag.create({ data: { name: 'Churning', color: '#FF8800' } }),
  ]);
  // Tag some records
  const allContacts = await prisma.contact.findMany({ take: 3 });
  const allDeals = await prisma.deal.findMany({ take: 2 });
  await Promise.all([
    prisma.tagAssignment.create({ data: { tagId: tags[0].id, module: 'contacts', recordId: allContacts[0].id } }),
    prisma.tagAssignment.create({ data: { tagId: tags[3].id, module: 'contacts', recordId: allContacts[0].id } }),
    prisma.tagAssignment.create({ data: { tagId: tags[1].id, module: 'deals', recordId: allDeals[0].id } }),
  ]);
  console.log('  5 tags, 3 assignments');

  // ─── NOTES ───
  await Promise.all([
    prisma.note.create({ data: { module: 'contacts', recordId: allContacts[0].id, body: 'Key decision maker at Acme Corp. Prefers email over phone.', pinned: true, authorId: users[0].id } }),
    prisma.note.create({ data: { module: 'contacts', recordId: allContacts[1].id, body: 'Met at SaaS Connect conference. Interested in our enterprise tier.', pinned: false, authorId: users[0].id } }),
    prisma.note.create({ data: { module: 'deals', recordId: allDeals[0].id, body: 'Budget approved by CFO. Need to finalize contract terms by end of month.', pinned: true, authorId: users[0].id } }),
  ]);
  console.log('  3 notes');

  // ─── LEAD SCORING RULES ───
  await Promise.all([
    prisma.leadScoringRule.create({ data: { name: 'Has Company', field: 'company', operator: 'is_not_empty', value: '', points: 10, active: true } }),
    prisma.leadScoringRule.create({ data: { name: 'Has Email', field: 'email', operator: 'is_not_empty', value: '', points: 15, active: true } }),
    prisma.leadScoringRule.create({ data: { name: 'Enterprise Company', field: 'company', operator: 'contains', value: 'Corp', points: 20, active: true } }),
    prisma.leadScoringRule.create({ data: { name: 'Hot Source', field: 'source', operator: 'equals', value: 'Website', points: 25, active: true } }),
  ]);
  console.log('  4 lead scoring rules');

  // ─── ASSIGNMENT RULES ───
  await Promise.all([
    prisma.assignmentRule.create({ data: { name: 'Round Robin Leads', module: 'leads', type: 'round_robin', assignees: [users[0].id, users[1].id, users[2].id], active: true, lastIndex: 0 } }),
    prisma.assignmentRule.create({ data: { name: 'Round Robin Cases', module: 'cases', type: 'round_robin', assignees: [users[1].id, users[2].id], active: true, lastIndex: 0 } }),
  ]);
  console.log('  2 assignment rules');

  // ─── EMAILS ───
  await Promise.all([
    prisma.email.create({ data: { subject: 'Follow up on our call', body: 'Hi, just following up on our conversation yesterday about the integration timeline...', status: 'sent', sentAt: new Date(), contactId: allContacts[0].id } }),
    prisma.email.create({ data: { subject: 'Proposal for Q2 engagement', body: 'Please find attached our proposal for the Q2 engagement...', status: 'draft', contactId: allContacts[1].id } }),
    prisma.email.create({ data: { subject: 'Meeting recap - Partnership discussion', body: 'Thank you for meeting with us today. Here are the key takeaways...', status: 'sent', sentAt: new Date(Date.now() - 86400000), contactId: allContacts[2].id } }),
  ]);
  console.log('  3 emails');

  // ─── QUOTES & INVOICES ───
  const allProducts = await prisma.product.findMany({ take: 3 });
  const allAccounts = await prisma.account.findMany({ take: 2 });

  const quote = await prisma.quote.create({ data: {
    number: 'Q-2025-001',
    dealId: allDeals[0].id,
    accountId: allAccounts[0].id,
    contactId: allContacts[0].id,
    status: 'Draft',
    subtotal: 25000,
    discount: 2500,
    tax: 2025,
    total: 24525,
    validUntil: new Date(Date.now() + 30 * 86400000),
    terms: 'Net 30',
  }});
  await Promise.all([
    prisma.quoteItem.create({ data: { quoteId: quote.id, productId: allProducts[0].id, quantity: 5, unitPrice: 3000, total: 15000 } }),
    prisma.quoteItem.create({ data: { quoteId: quote.id, productId: allProducts[1].id, quantity: 2, unitPrice: 5000, total: 10000 } }),
  ]);

  const invoice = await prisma.invoice.create({ data: {
    number: 'INV-2025-001',
    quoteId: quote.id,
    accountId: allAccounts[0].id,
    contactId: allContacts[0].id,
    status: 'Sent',
    subtotal: 24525,
    tax: 2025,
    total: 26550,
    date: new Date(),
    dueDate: new Date(Date.now() + 30 * 86400000),
    terms: 'Net 30',
  }});
  await Promise.all([
    prisma.invoiceItem.create({ data: { invoiceId: invoice.id, productId: allProducts[0].id, quantity: 5, unitPrice: 3000, total: 15000, description: 'CRM Pro License' } }),
    prisma.invoiceItem.create({ data: { invoiceId: invoice.id, productId: allProducts[1].id, quantity: 2, unitPrice: 5000, total: 10000, description: 'API Access Package' } }),
  ]);
  console.log('  1 quote + 2 items, 1 invoice + 2 items');

  // ─── DEAL LINE ITEMS ───
  await Promise.all([
    prisma.dealLineItem.create({ data: { dealId: allDeals[0].id, productId: allProducts[0].id, quantity: 10, price: 3000, total: 30000 } }),
    prisma.dealLineItem.create({ data: { dealId: allDeals[0].id, productId: allProducts[1].id, quantity: 5, price: 5000, total: 25000 } }),
  ]);
  console.log('  2 deal line items');

  // ─── SLA POLICIES ───
  await Promise.all([
    prisma.slaPolicy.create({ data: { name: 'Critical Response', priority: 'Critical', firstResponseMinutes: 30, resolutionMinutes: 240, escalateAfterMinutes: 60, active: true } }),
    prisma.slaPolicy.create({ data: { name: 'High Priority Response', priority: 'High', firstResponseMinutes: 120, resolutionMinutes: 480, escalateAfterMinutes: 240, active: true } }),
    prisma.slaPolicy.create({ data: { name: 'Normal Response', priority: 'Medium', firstResponseMinutes: 480, resolutionMinutes: 2880, escalateAfterMinutes: 960, active: true } }),
  ]);
  console.log('  3 SLA policies');

  // ─── EMAIL SEQUENCES ───
  const sequence = await prisma.emailSequence.create({ data: {
    name: 'New Lead Nurture',
    description: 'Automated drip for new inbound leads',
    steps: [
      { subject: 'Welcome to Sales Nebula', body: 'Thanks for your interest! Here is a quick overview of what we do...', delayDays: 0 },
      { subject: 'How companies like yours use Sales Nebula', body: 'Here are 3 case studies from companies in your industry...', delayDays: 3 },
      { subject: 'Ready for a demo?', body: 'Would you like to see Sales Nebula in action? Book a 15-min demo...', delayDays: 7 },
    ],
    active: true,
    createdById: users[0].id,
  }});
  console.log('  1 email sequence (3 steps)');

  // ─── SAVED VIEWS ───
  await Promise.all([
    prisma.savedView.create({ data: { name: 'My Open Deals', module: 'deals', filters: { stage: { notIn: ['Closed Won', 'Closed Lost'] } }, columns: ['name', 'stage', 'amount', 'closeDate'], sortBy: 'amount', sortDir: 'desc', isDefault: true, userId: users[0].id } }),
    prisma.savedView.create({ data: { name: 'Hot Leads', module: 'leads', filters: { score: { gte: 50 } }, columns: ['firstName', 'lastName', 'company', 'score', 'status'], sortBy: 'score', sortDir: 'desc', isDefault: false, userId: users[0].id } }),
    prisma.savedView.create({ data: { name: 'Overdue Cases', module: 'cases', filters: { status: { notIn: ['Resolved', 'Closed'] } }, columns: ['caseNumber', 'subject', 'priority', 'status', 'createdAt'], sortBy: 'createdAt', sortDir: 'asc', isDefault: false, userId: users[0].id } }),
  ]);
  console.log('  3 saved views');

  // ─── WEBHOOKS ───
  await prisma.webhook.create({ data: {
    name: 'Slack Notifications',
    url: 'https://hooks.slack.com/services/EXAMPLE/WEBHOOK',
    events: ['deal.stage_changed', 'lead.converted', 'case.escalated'],
    secret: 'example_webhook_secret_replace_me',
    active: false, // Inactive by default - needs real URL
    createdById: users[0].id,
  }});
  console.log('  1 webhook (inactive - needs config)');

  // ─── CURRENCIES ───
  await Promise.all([
    prisma.currency.create({ data: { code: 'USD', name: 'US Dollar', symbol: '$', exchangeRate: 1.0, isDefault: true } }),
    prisma.currency.create({ data: { code: 'EUR', name: 'Euro', symbol: '\u20ac', exchangeRate: 0.92 } }),
    prisma.currency.create({ data: { code: 'GBP', name: 'British Pound', symbol: '\u00a3', exchangeRate: 0.79 } }),
    prisma.currency.create({ data: { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', exchangeRate: 1.36 } }),
    prisma.currency.create({ data: { code: 'JPY', name: 'Japanese Yen', symbol: '\u00a5', exchangeRate: 149.5 } }),
  ]);
  console.log('  5 currencies (USD default)');

  // ─── SHARING RULES ───
  await Promise.all([
    prisma.sharingRule.create({ data: {
      name: 'Share All Deals with Sales Team',
      module: 'deals',
      type: 'criteria_based',
      sharedFrom: { field: 'stage', operator: 'not_in', value: ['Closed Lost'] },
      sharedTo: { type: 'role', value: 'Sales Rep' },
      accessLevel: 'read',
      createdById: users[0].id,
    }}),
    prisma.sharingRule.create({ data: {
      name: 'Share Cases with Support Team',
      module: 'cases',
      type: 'owner_based',
      sharedTo: { type: 'role', value: 'Support Rep' },
      accessLevel: 'edit',
      createdById: users[0].id,
    }}),
  ]);
  console.log('  2 sharing rules');

  // ─── CAMPAIGNS ───
  const campaign = await prisma.campaign.create({ data: {
    name: 'Q1 2025 Product Launch',
    type: 'Email',
    status: 'Active',
    startDate: new Date(),
    endDate: new Date(Date.now() + 90 * 86400000),
    budget: 50000,
    description: 'Multi-channel campaign for new enterprise features launch',
    ownerId: users[0].id,
  }});
  await Promise.all([
    prisma.campaignRecipient.create({ data: { campaignId: campaign.id, contactId: allContacts[0].id, status: 'Sent' } }),
    prisma.campaignRecipient.create({ data: { campaignId: campaign.id, contactId: allContacts[1].id, status: 'Opened' } }),
    prisma.campaignRecipient.create({ data: { campaignId: campaign.id, contactId: allContacts[2].id, status: 'Clicked' } }),
  ]);
  console.log('  1 campaign + 3 recipients');

  // ─── DOCUMENTS ───
  await Promise.all([
    prisma.document.create({ data: { name: 'Acme Corp - MSA.pdf', fileName: 'acme-msa.pdf', mimeType: 'application/pdf', fileSize: 245000, filePath: '/uploads/acme-msa.pdf', accountId: allAccounts[0].id, contactId: allContacts[0].id } }),
    prisma.document.create({ data: { name: 'Product Datasheet.pdf', fileName: 'datasheet.pdf', mimeType: 'application/pdf', fileSize: 128000, filePath: '/uploads/datasheet.pdf', dealId: allDeals[0].id } }),
  ]);
  console.log('  2 documents');

  // ─── FORECAST ITEMS ───
  const forecasts = await prisma.forecast.findMany({ take: 1 });
  if (forecasts.length > 0) {
    await Promise.all([
      prisma.forecastItem.create({ data: { forecastId: forecasts[0].id, dealId: allDeals[0].id, amount: allDeals[0].amount || 50000, category: 'Commit', probability: 90, notes: 'Contract in legal review' } }),
      prisma.forecastItem.create({ data: { forecastId: forecasts[0].id, dealId: allDeals[1].id, amount: allDeals[1].amount || 25000, category: 'Best Case', probability: 50, notes: 'Pending budget approval' } }),
    ]);
    console.log('  2 forecast items');
  }

  // ─── APPROVAL PROCESS STEPS ───
  const approvalProcesses = await prisma.approvalProcess.findMany({ take: 1 });
  if (approvalProcesses.length > 0) {
    await prisma.approvalProcessStep.create({ data: {
      processId: approvalProcesses[0].id,
      stepOrder: 1,
      name: 'Manager Approval',
      approverType: 'user',
      approverId: users[1].id,
    }});
    await prisma.approvalProcessStep.create({ data: {
      processId: approvalProcesses[0].id,
      stepOrder: 2,
      name: 'VP Approval',
      approverType: 'user',
      approverId: users[0].id,
    }});
    console.log('  2 approval process steps');
  }

  // ─── CONTRACTS ───
  const contract = await prisma.contract.create({ data: {
    contractNumber: 'CON-0001',
    accountId: allAccounts[0].id,
    contactId: allContacts[0].id,
    status: 'Activated',
    startDate: new Date('2025-01-01'),
    endDate: new Date('2026-01-01'),
    contractTerm: 12,
    billingFrequency: 'Monthly',
    totalValue: 120000,
    autoRenew: true,
    specialTerms: 'Net 30 payment terms, 99.9% SLA uptime guarantee',
    description: 'Annual CRM Enterprise License Agreement',
    ownerId: thomas.id,
    signedDate: new Date('2025-01-01'),
  }});
  console.log('  1 contract');

  // ─── ORDERS ───
  const order = await prisma.order.create({ data: {
    orderNumber: 'ORD-0001',
    accountId: allAccounts[0].id,
    contactId: allContacts[0].id,
    contractId: contract.id,
    quoteId: quote.id,
    status: 'Activated',
    type: 'New',
    subtotal: 25000,
    tax: 2500,
    total: 27500,
    activatedDate: new Date(),
    ownerId: thomas.id,
    items: { create: [
      { productId: allProducts[0].id, description: 'CRM Pro License', quantity: 5, unitPrice: 3000, total: 15000 },
      { productId: allProducts[1].id, description: 'API Access', quantity: 2, unitPrice: 5000, total: 10000 },
    ]},
  }});
  console.log('  1 order with 2 items');

  // ─── ENTITLEMENTS ───
  await prisma.entitlement.create({ data: {
    name: 'Enterprise Support - Acme Corp',
    accountId: allAccounts[0].id,
    contractId: contract.id,
    type: 'Support',
    status: 'Active',
    startDate: new Date('2025-01-01'),
    endDate: new Date('2026-01-01'),
    casesAllowed: 100,
    casesUsed: 3,
    responseTime: 4,
    resolutionTime: 24,
    businessHours: '24x7',
    milestones: { create: [
      { name: 'First Response', type: 'ResponseTime', triggerMinutes: 240, violationAction: { type: 'escalate', to: 'manager' } },
      { name: 'Resolution', type: 'ResolutionTime', triggerMinutes: 1440, violationAction: { type: 'notify', to: 'vp_support' } },
    ]},
  }});
  console.log('  1 entitlement with 2 milestones');

  // ─── TEAMS ───
  await Promise.all([
    prisma.accountTeam.create({ data: { accountId: allAccounts[0].id, userId: thomas.id, role: 'Account Manager', access: 'full' } }),
    prisma.accountTeam.create({ data: { accountId: allAccounts[0].id, userId: sam.id, role: 'Sales Rep', access: 'edit' } }),
    prisma.dealTeam.create({ data: { dealId: allDeals[0].id, userId: thomas.id, role: 'Sales Rep', access: 'full', splitPercent: 60 } }),
    prisma.dealTeam.create({ data: { dealId: allDeals[0].id, userId: sam.id, role: 'Sales Engineer', access: 'edit', splitPercent: 40 } }),
  ]);
  console.log('  2 account team members, 2 deal team members');

  // ─── CAMPAIGN INFLUENCE ───
  const allCampaigns = await prisma.campaign.findMany({ take: 1 });
  if (allCampaigns.length > 0) {
    await Promise.all([
      prisma.campaignInfluence.create({ data: { campaignId: allCampaigns[0].id, dealId: allDeals[0].id, model: 'FirstTouch', influence: 60, revenue: 30000, isPrimary: true, touchDate: new Date('2025-06-01') } }),
      prisma.campaignInfluence.create({ data: { campaignId: allCampaigns[0].id, dealId: allDeals[0].id, model: 'Linear', influence: 33, revenue: 16500, touchDate: new Date('2025-06-01') } }),
    ]);
    console.log('  2 campaign influence records');
  }

  // ─── DUPLICATE RULES ───
  await Promise.all([
    prisma.duplicateRule.create({ data: { name: 'Contact Email Match', module: 'contacts', action: 'warn', matchFields: [{ field: 'email', weight: 100 }, { field: 'phone', weight: 60 }], threshold: 80 } }),
    prisma.duplicateRule.create({ data: { name: 'Lead Company+Name Match', module: 'leads', action: 'warn', matchFields: [{ field: 'email', weight: 100 }, { field: 'company', weight: 50 }, { field: 'lastName', weight: 40 }], threshold: 75 } }),
    prisma.duplicateRule.create({ data: { name: 'Account Name Match', module: 'accounts', action: 'block', matchFields: [{ field: 'name', weight: 100 }, { field: 'website', weight: 70 }], threshold: 90 } }),
  ]);
  console.log('  3 duplicate rules');

  // ─── VALIDATION RULES ───
  await Promise.all([
    prisma.validationRule.create({ data: { name: 'Deal close date required', module: 'deals', condition: { field: 'closeDate', operator: 'required' }, errorMessage: 'Close date is required for all deals', errorField: 'closeDate' } }),
    prisma.validationRule.create({ data: { name: 'Lead email format', module: 'leads', condition: { field: 'email', operator: 'regex', value: '^[^@]+@[^@]+\\.[^@]+$' }, errorMessage: 'Please enter a valid email address', errorField: 'email' } }),
    prisma.validationRule.create({ data: { name: 'Deal value minimum', module: 'deals', condition: { field: 'value', operator: 'gt', value: 0 }, errorMessage: 'Deal value must be greater than zero', errorField: 'value' } }),
    prisma.validationRule.create({ data: { name: 'Case subject length', module: 'cases', condition: { field: 'subject', operator: 'min_length', value: 5 }, errorMessage: 'Subject must be at least 5 characters', errorField: 'subject' } }),
  ]);
  console.log('  4 validation rules');

  // ─── RECORD TYPES ───
  await Promise.all([
    prisma.recordType.create({ data: { name: 'B2B', module: 'contacts', isDefault: true, description: 'Business contacts' } }),
    prisma.recordType.create({ data: { name: 'B2C', module: 'contacts', description: 'Consumer contacts' } }),
    prisma.recordType.create({ data: { name: 'New Business', module: 'deals', isDefault: true, description: 'New customer deals' } }),
    prisma.recordType.create({ data: { name: 'Renewal', module: 'deals', description: 'Existing customer renewals' } }),
    prisma.recordType.create({ data: { name: 'Upsell', module: 'deals', description: 'Expansion deals' } }),
  ]);
  console.log('  5 record types');

  // ─── PAGE LAYOUTS ───
  await Promise.all([
    prisma.pageLayout.create({ data: { name: 'Contact - Standard', module: 'contacts', sections: [{ label: 'Contact Info', columns: 2, fields: [{ name: 'firstName', required: true }, { name: 'lastName', required: true }, { name: 'email' }, { name: 'phone' }] }, { label: 'Address', columns: 2, fields: [{ name: 'street' }, { name: 'city' }, { name: 'state' }, { name: 'zip' }] }] } }),
    prisma.pageLayout.create({ data: { name: 'Deal - Standard', module: 'deals', sections: [{ label: 'Deal Info', columns: 2, fields: [{ name: 'name', required: true }, { name: 'stage', required: true }, { name: 'value' }, { name: 'closeDate' }] }, { label: 'Details', columns: 1, fields: [{ name: 'description' }] }] } }),
  ]);
  console.log('  2 page layouts');

  // ─── ORG-WIDE DEFAULTS ───
  await Promise.all([
    prisma.orgWideDefault.create({ data: { module: 'contacts', internalAccess: 'ReadWrite', externalAccess: 'Private' } }),
    prisma.orgWideDefault.create({ data: { module: 'deals', internalAccess: 'Private', externalAccess: 'Private', grantAccessUsing: 'hierarchy' } }),
    prisma.orgWideDefault.create({ data: { module: 'accounts', internalAccess: 'ReadWrite', externalAccess: 'Private' } }),
    prisma.orgWideDefault.create({ data: { module: 'cases', internalAccess: 'ReadWrite', externalAccess: 'Private' } }),
    prisma.orgWideDefault.create({ data: { module: 'leads', internalAccess: 'ReadWrite', externalAccess: 'Private' } }),
  ]);
  console.log('  5 org-wide defaults');

  // ─── ROLE HIERARCHY ───
  const rolesForHierarchy = await prisma.role.findMany();
  const hierAdmin = rolesForHierarchy.find(r => r.name === 'Admin');
  const hierMgr = rolesForHierarchy.find(r => r.name === 'Manager');
  const hierRep = rolesForHierarchy.find(r => r.name === 'Sales Rep');
  if (hierAdmin && hierMgr && hierRep) {
    await Promise.all([
      prisma.roleHierarchy.create({ data: { roleId: hierAdmin.id, parentId: null, level: 0 } }),
      prisma.roleHierarchy.create({ data: { roleId: hierMgr.id, parentId: hierAdmin.id, level: 1 } }),
      prisma.roleHierarchy.create({ data: { roleId: hierRep.id, parentId: hierMgr.id, level: 2 } }),
    ]);
    console.log('  3 role hierarchy entries');
  }

  // ─── SALES PATH ───
  await prisma.salesPath.create({ data: {
    module: 'deals',
    active: true,
    steps: { create: [
      { stageName: 'Prospecting', stepOrder: 0, guidance: 'Research the company and identify key stakeholders. Prepare a compelling value proposition.', keyFields: ['name', 'accountId', 'value'], successCriteria: 'Initial meeting scheduled' },
      { stageName: 'Qualification', stepOrder: 1, guidance: 'Confirm budget, authority, need, and timeline (BANT). Understand their pain points deeply.', keyFields: ['value', 'closeDate', 'probability'], successCriteria: 'BANT criteria confirmed' },
      { stageName: 'Proposal', stepOrder: 2, guidance: 'Build a tailored proposal addressing their specific needs. Include ROI analysis and competitive differentiators.', keyFields: ['value', 'closeDate'], successCriteria: 'Proposal delivered and reviewed' },
      { stageName: 'Negotiation', stepOrder: 3, guidance: 'Address objections, negotiate terms. Involve legal for contract review. Prepare for close.', keyFields: ['value', 'closeDate', 'probability'], successCriteria: 'Terms agreed upon' },
      { stageName: 'Closed Won', stepOrder: 4, guidance: 'Execute contract, schedule onboarding, introduce customer success team.', successCriteria: 'Contract signed' },
    ]},
  }});
  console.log('  1 sales path with 5 steps');

  // ─── MACROS ───
  await Promise.all([
    prisma.macro.create({ data: { name: 'Qualify Lead', module: 'leads', createdById: thomas.id, sortOrder: 1, actions: [{ type: 'updateField', field: 'status', value: 'Qualified' }, { type: 'createActivity', subject: 'Follow-up call', activityType: 'Call' }] } }),
    prisma.macro.create({ data: { name: 'Escalate Case', module: 'cases', createdById: thomas.id, sortOrder: 2, actions: [{ type: 'updateField', field: 'priority', value: 'Critical' }, { type: 'updateField', field: 'status', value: 'Escalated' }] } }),
    prisma.macro.create({ data: { name: 'Close Won Checklist', module: 'deals', createdById: thomas.id, sortOrder: 3, actions: [{ type: 'updateField', field: 'stage', value: 'Closed Won' }, { type: 'createActivity', subject: 'Schedule onboarding', activityType: 'Task' }] } }),
  ]);
  console.log('  3 macros');

  // ─── EVENT SUBSCRIPTIONS ───
  await Promise.all([
    prisma.eventSubscription.create({ data: { channel: 'deal.closed_won', endpoint: 'internal://celebration', type: 'websocket' } }),
    prisma.eventSubscription.create({ data: { channel: 'case.escalated', endpoint: 'internal://support-alert', type: 'websocket' } }),
  ]);
  console.log('  2 event subscriptions');

  console.log('\nSeed complete! Login with thomas@salesnebula.com / password123\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
