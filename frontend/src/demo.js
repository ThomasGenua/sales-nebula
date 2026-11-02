export const DEMO_LOGIN = {
  email: "demo@salesnebula.com",
  password: "Demo1234!",
};

export const DEMO_USER = {
  id: "demo-local-user",
  email: DEMO_LOGIN.email,
  firstName: "Demo",
  lastName: "Visitor",
  avatar: "DV",
  active: true,
  role: { id: "demo-local-role", name: "Demo", permissions: ['leads', 'contacts', 'accounts', 'deals', 'quotes', 'products', 'activities'].map(module => ({ module, level: 'read' })) },
};

const deals = [
  { id: "demo-deal-1", name: "TechStart team rollout", stage: "Negotiation", value: 32000, probability: 75, closeDate: "2026-12-18T12:00:00Z", accountId: "demo-account-1", account: { id: "demo-account-1", name: "TechStart" }, contactId: "demo-contact-1", contact: { firstName: "Anna", lastName: "Martinez" }, description: "A shared workspace for the sales team, with onboarding and an implementation plan.", updatedAt: "2026-11-01T09:00:00Z" },
  { id: "demo-deal-2", name: "Globex Sales Rollout", stage: "Proposal", value: 180000, probability: 50, account: { name: "Globex Industries" }, updatedAt: "2026-08-21T14:30:00Z" },
  { id: "demo-deal-3", name: "Stark Analytics Suite", stage: "Discovery", value: 120000, probability: 25, account: { name: "Stark Ventures" }, updatedAt: "2026-08-20T11:15:00Z" },
  { id: "demo-deal-4", name: "Initech Support Renewal", stage: "Closed Won", value: 85000, probability: 100, account: { name: "Initech" }, updatedAt: "2026-08-19T16:45:00Z" },
];

const datasets = {
  "/contacts": [
    { id: "demo-contact-1", firstName: "Anna", lastName: "Martinez", email: "anna@techstart.example", phone: "+1 555 0101", title: "VP Sales", status: "Active", accountId: "demo-account-1", account: { name: "TechStart" } },
    { id: "demo-contact-2", firstName: "Michael", lastName: "Torres", email: "michael@globex.example", phone: "+1 555 0102", title: "CTO", status: "Active", account: { name: "Globex Industries" } },
    { id: "demo-contact-3", firstName: "Emily", lastName: "Zhang", email: "emily@stark.example", phone: "+1 555 0103", title: "Director of Operations", status: "Active", account: { name: "Stark Ventures" } },
  ],
  "/leads": [
    { id: "demo-lead-1", firstName: "Anna", lastName: "Martinez", email: "anna@techstart.example", company: "TechStart", source: "Website", status: "Qualified", score: 85, value: 32000, phone: "+1 555 0101", title: "VP Sales", description: "Looking for one place to manage follow-ups, opportunities, and proposals for a growing sales team." },
    { id: "demo-lead-2", firstName: "Robert", lastName: "Johnson", email: "robert@bigcorp.example", company: "BigCorp", source: "Trade Show", status: "Contacted", score: 72, value: 300000 },
    { id: "demo-lead-3", firstName: "Sophie", lastName: "Williams", email: "sophie@innovate.example", company: "Innovate Co", source: "LinkedIn", status: "Qualified", score: 91, value: 500000 },
  ],
  "/deals": deals,
  "/accounts": [
    { id: "demo-account-1", name: "TechStart", industry: "Technology", type: "Prospect", annualRevenue: 5000000, employees: 250, phone: "+1 555 0201" },
    { id: "demo-account-2", name: "Globex Industries", industry: "Manufacturing", type: "Prospect", revenue: 12000000, employees: 800, phone: "+1 555 0202" },
    { id: "demo-account-3", name: "Stark Ventures", industry: "Finance", type: "Customer", revenue: 25000000, employees: 1200, phone: "+1 555 0203" },
  ],
  "/activities": [
    { id: "demo-activity-1", type: "Call", subject: "Follow up on proposal", status: "Scheduled", priority: "High", date: "2026-08-25T10:00:00Z" },
    { id: "demo-activity-2", type: "Meeting", subject: "Quarterly account review", status: "Scheduled", priority: "Medium", date: "2026-08-26T14:00:00Z" },
    { id: "demo-activity-3", type: "Email", subject: "Send implementation plan", status: "Completed", priority: "Medium", date: "2026-08-23T09:30:00Z" },
  ],
  "/cases": [
    { id: "demo-case-1", caseNumber: "CASE-1042", subject: "Import mapping question", status: "New", priority: "Medium", origin: "Email" },
    { id: "demo-case-2", caseNumber: "CASE-1041", subject: "Dashboard permissions", status: "In Progress", priority: "High", origin: "Web" },
  ],
  "/products": [
    { id: "demo-product-1", name: "Sales Nebula Pro", sku: "SN-PRO", category: "Software", price: 12000, active: true },
    { id: "demo-product-2", name: "Implementation Package", sku: "SN-IMP", category: "Services", price: 8000, active: true },
  ],
  "/quotes": [{ id: "demo-quote-1", name: "TechStart rollout proposal", number: "Q-DEMO-1042", status: "Draft", total: 32000, subtotal: 32000, discount: 0, tax: 0, validUntil: "2026-12-18T12:00:00Z", terms: "Fictional sample proposal for the product tour. These amounts are not Sales Nebula pricing.", dealId: "demo-deal-1", deal: deals[0], accountId: "demo-account-1", account: { name: "TechStart" }, items: [
    { id: "demo-line-1", description: "Sample annual software licenses", quantity: 20, unitPrice: 1200, total: 24000 },
    { id: "demo-line-2", description: "Sample implementation package", quantity: 1, unitPrice: 8000, total: 8000 },
  ] }],
};

export function isDemoUser(user) {
  return String(user?.email || "").toLowerCase() === DEMO_LOGIN.email;
}

export async function demoApiFetch(path, opts = {}) {
  const method = String(opts.method || "GET").toUpperCase();

  if (path === "/copilot/ask" && method === "POST") {
    return {
      answer: "This is the frontend-only demo assistant. Create an account to connect Copilot to your CRM data.",
    };
  }

  if (method !== "GET") {
    throw new Error("Demo mode is read-only. Create an account to make changes.");
  }

  const pathname = path.split("?")[0];
  if (pathname === "/auth/me") return { user: DEMO_USER };
  if (pathname === '/quotes/currency') return { currency: 'USD' };
  if (pathname === '/deals/currencies') return { base: 'USD', data: [{ code: 'USD', name: 'US Dollar' }] };
  if (pathname === "/dashboard") {
    return {
      counts: { contacts: 128, accounts: 34, leads: 42, openDeals: 18, wonDeals: 7, lostDeals: 3, openCases: 6 },
      pipeline: { totalValue: 1245000, dealCount: 18, winRate: 38 },
      revenue: { wonThisMonth: { value: 335000, count: 7 } },
      winRate: 38,
    };
  }
  if (pathname === "/deals/stats/pipeline") {
    return {
      pipeline: [
        { stage: "Qualification", value: 180000, count: 5 },
        { stage: "Discovery", value: 320000, count: 4 },
        { stage: "Proposal", value: 410000, count: 5 },
        { stage: "Negotiation", value: 335000, count: 4 },
      ],
    };
  }
  if (pathname === "/calendar/invitations/pending") return { invitations: [] };
  if (/^\/quotes\/[^/]+\/shares$/.test(pathname)) return [];
  if (pathname.startsWith('/configuration/record-metadata/')) return { recordTypes: [], layouts: [], fieldPermissions: [] };
  if (pathname === '/quotes/demo-quote-1/pdf') return { html: '<!doctype html><html><body style="font-family:system-ui;padding:32px"><h1>TechStart rollout proposal</h1><p>Q-DEMO-1042 · Fictional sample, not Sales Nebula pricing</p><p>20 sample annual licenses × $1,200 = $24,000</p><p>Implementation package: $8,000</p><h2>Total: $32,000</h2><p>Draft · No payment or signature is requested.</p></body></html>' };

  const dataset = datasets[pathname];
  if (dataset) {
    const params = new URLSearchParams(path.split('?')[1] || '');
    const rows = dataset.filter(row => ['accountId', 'contactId', 'dealId'].every(key => !params.get(key) || row[key] === params.get(key)));
    return { data: rows, total: rows.length };
  }
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 2 && datasets[`/${parts[0]}`]) {
    const record = datasets[`/${parts[0]}`].find(row => row.id === parts[1]);
    if (!record) throw new Error('This record is not part of the sample workspace.');
    return record;
  }

  return { data: [], items: [], total: 0 };
}
