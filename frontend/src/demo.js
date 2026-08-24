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
  role: { id: "demo-local-role", name: "Demo", permissions: [] },
};

const deals = [
  { id: "demo-deal-1", name: "Acme Enterprise CRM", stage: "Negotiation", value: 250000, probability: 75, account: { name: "Acme Corporation" }, updatedAt: "2026-08-22T09:00:00Z" },
  { id: "demo-deal-2", name: "Globex Sales Rollout", stage: "Proposal", value: 180000, probability: 50, account: { name: "Globex Industries" }, updatedAt: "2026-08-21T14:30:00Z" },
  { id: "demo-deal-3", name: "Stark Analytics Suite", stage: "Discovery", value: 120000, probability: 25, account: { name: "Stark Ventures" }, updatedAt: "2026-08-20T11:15:00Z" },
  { id: "demo-deal-4", name: "Initech Support Renewal", stage: "Closed Won", value: 85000, probability: 100, account: { name: "Initech" }, updatedAt: "2026-08-19T16:45:00Z" },
];

const datasets = {
  "/contacts": [
    { id: "demo-contact-1", firstName: "Sarah", lastName: "Chen", email: "sarah@acme.example", phone: "+1 555 0101", title: "VP Sales", status: "Active", account: { name: "Acme Corporation" } },
    { id: "demo-contact-2", firstName: "Michael", lastName: "Torres", email: "michael@globex.example", phone: "+1 555 0102", title: "CTO", status: "Active", account: { name: "Globex Industries" } },
    { id: "demo-contact-3", firstName: "Emily", lastName: "Zhang", email: "emily@stark.example", phone: "+1 555 0103", title: "Director of Operations", status: "Active", account: { name: "Stark Ventures" } },
  ],
  "/leads": [
    { id: "demo-lead-1", firstName: "Anna", lastName: "Martinez", email: "anna@techstart.example", company: "TechStart", source: "Website", status: "New", score: 85, value: 150000 },
    { id: "demo-lead-2", firstName: "Robert", lastName: "Johnson", email: "robert@bigcorp.example", company: "BigCorp", source: "Trade Show", status: "Contacted", score: 72, value: 300000 },
    { id: "demo-lead-3", firstName: "Sophie", lastName: "Williams", email: "sophie@innovate.example", company: "Innovate Co", source: "LinkedIn", status: "Qualified", score: 91, value: 500000 },
  ],
  "/deals": deals,
  "/accounts": [
    { id: "demo-account-1", name: "Acme Corporation", industry: "Technology", type: "Customer", revenue: 5000000, employees: 250, phone: "+1 555 0201" },
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

  const dataset = datasets[pathname];
  if (dataset) return { data: dataset, total: dataset.length };

  return { data: [], items: [], total: 0 };
}
