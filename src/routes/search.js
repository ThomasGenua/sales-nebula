const { Router } = require('express');
const { authenticate } = require('../middleware/auth');

const router = Router();
router.use(authenticate);

// GET /api/search?q=term&modules=contacts,deals&limit=5
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, modules, limit = 5 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const take = Math.min(parseInt(limit) || 5, 20);
    const search = q.trim();
    const requestedModules = modules ? modules.split(',') : ['contacts', 'leads', 'deals', 'accounts', 'cases', 'products'];
    const results = {};

    const searchConfigs = {
      contacts: () => prisma.contact.findMany({
        where: { OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, firstName: true, lastName: true, email: true, title: true, accountId: true },
        take,
      }),
      leads: () => prisma.lead.findMany({
        where: { OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { company: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, firstName: true, lastName: true, company: true, email: true, status: true },
        take,
      }),
      deals: () => prisma.deal.findMany({
        where: { name: { contains: search, mode: 'insensitive' } },
        select: { id: true, name: true, stage: true, value: true },
        take,
      }),
      accounts: () => prisma.account.findMany({
        where: { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { industry: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, name: true, industry: true, type: true },
        take,
      }),
      cases: () => prisma.case.findMany({
        where: { OR: [
          { subject: { contains: search, mode: 'insensitive' } },
          { caseNumber: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, caseNumber: true, subject: true, status: true, priority: true },
        take,
      }),
      products: () => prisma.product.findMany({
        where: { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, name: true, sku: true, price: true, category: true },
        take,
      }),
      knowledge: () => prisma.knowledgeArticle.findMany({
        where: { OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { body: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, title: true, category: true, status: true },
        take,
      }),
    };

    // Run all searches in parallel
    const entries = await Promise.all(
      requestedModules.filter(m => searchConfigs[m]).map(async (module) => {
        try {
          const data = await searchConfigs[module]();
          return [module, data];
        } catch (e) {
          return [module, []];
        }
      })
    );

    for (const [module, data] of entries) {
      if (data.length > 0) results[module] = data;
    }

    const totalResults = Object.values(results).reduce((s, arr) => s + arr.length, 0);
    res.json({ query: search, totalResults, results });
  } catch (err) { next(err); }
});

module.exports = router;

// Search history
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const history = await prisma.searchHistory.findMany({
      where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 20,
    }).catch(() => []);
    res.json(history);
  } catch (err) { next(err); }
});

// Search suggestions (autocomplete)
router.get('/suggest', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ suggestions: [] });
    const [contacts, deals, accounts] = await Promise.all([
      prisma.contact.findMany({ where: { deletedAt: null, OR: [{ firstName: { startsWith: q, mode: 'insensitive' } }, { lastName: { startsWith: q, mode: 'insensitive' } }, { email: { startsWith: q, mode: 'insensitive' } }] }, select: { id: true, firstName: true, lastName: true, email: true }, take: 5 }),
      prisma.deal.findMany({ where: { deletedAt: null, name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true, stage: true }, take: 5 }),
      prisma.account.findMany({ where: { deletedAt: null, name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true }, take: 5 }),
    ]);
    res.json({ suggestions: [
      ...contacts.map(c => ({ type: 'contact', id: c.id, text: `${c.firstName} ${c.lastName}`, sub: c.email })),
      ...deals.map(d => ({ type: 'deal', id: d.id, text: d.name, sub: d.stage })),
      ...accounts.map(a => ({ type: 'account', id: a.id, text: a.name })),
    ]});
  } catch (err) { next(err); }
});

// Module-specific search
router.get('/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.params;
    const { q, limit = 25 } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const moduleMap = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', products: 'product' };
    const model = moduleMap[module];
    if (!model) return res.status(400).json({ error: 'Invalid module' });
    const searchFields = { contact: ['firstName','lastName','email'], lead: ['firstName','lastName','company','email'], deal: ['name','description'], account: ['name','website'], case: ['subject','description'], product: ['name','code'] };
    const fields = searchFields[model] || ['name'];
    const where = { deletedAt: null, OR: fields.map(f => ({ [f]: { contains: q, mode: 'insensitive' } })) };
    const results = await prisma[model].findMany({ where, take: Math.min(+limit, 100), orderBy: { updatedAt: 'desc' } });
    res.json({ module, query: q, results, count: results.length });
  } catch (err) { next(err); }
});
