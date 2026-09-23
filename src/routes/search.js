const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { modelHasField } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

/*
 * Search answered from every row of every module to anyone signed in: other
 * reps' contacts, leads, deals and cases, deleted ones included. Each module
 * is now searched only for users who may read it, over the rows their row
 * security allows.
 */
const MODELS = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', products: 'product', knowledge: 'knowledgeArticle' };

/** One module's matches for this user, or none when they may not read it. */
async function searchModule(req, module, args) {
  if (!permits(req, module, 'read')) return [];
  const model = MODELS[module];
  return req.app.locals.prisma[model].findMany({ ...args, where: await reachableWhere(req, module, model, args.where) });
}

// GET /api/search?q=term&modules=contacts,deals&limit=5
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, modules, limit = 5 } = req.query;

    if (!q || String(q).trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const take = Math.min(parseInt(limit) || 5, 20);
    const search = String(q).trim();
    const requestedModules = modules ? String(modules).split(',') : ['contacts', 'leads', 'deals', 'accounts', 'cases', 'products'];
    const results = {};

    const searchConfigs = {
      contacts: () => searchModule(req, 'contacts', {
        where: { OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, firstName: true, lastName: true, email: true, title: true, accountId: true },
        take,
      }),
      leads: () => searchModule(req, 'leads', {
        where: { OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { company: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, firstName: true, lastName: true, company: true, email: true, status: true },
        take,
      }),
      deals: () => searchModule(req, 'deals', {
        where: { name: { contains: search, mode: 'insensitive' } },
        select: { id: true, name: true, stage: true, value: true },
        take,
      }),
      accounts: () => searchModule(req, 'accounts', {
        where: { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { industry: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, name: true, industry: true, type: true },
        take,
      }),
      cases: () => searchModule(req, 'cases', {
        where: { OR: [
          { subject: { contains: search, mode: 'insensitive' } },
          { caseNumber: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, caseNumber: true, subject: true, status: true, priority: true },
        take,
      }),
      products: () => searchModule(req, 'products', {
        where: { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, name: true, sku: true, price: true, category: true },
        take,
      }),
      knowledge: () => searchModule(req, 'knowledge', {
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
    const q = String(req.query.q || '');
    if (q.length < 2) return res.json({ suggestions: [] });
    const [contacts, deals, accounts] = await Promise.all([
      searchModule(req, 'contacts', { where: { OR: [{ firstName: { startsWith: q, mode: 'insensitive' } }, { lastName: { startsWith: q, mode: 'insensitive' } }, { email: { startsWith: q, mode: 'insensitive' } }] }, select: { id: true, firstName: true, lastName: true, email: true }, take: 5 }),
      searchModule(req, 'deals', { where: { name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true, stage: true }, take: 5 }),
      searchModule(req, 'accounts', { where: { name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true }, take: 5 }),
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
    const { limit = 25 } = req.query;
    const q = req.query.q ? String(req.query.q) : '';
    if (!q) return res.status(400).json({ error: 'q required' });
    const model = module === 'knowledge' ? null : MODELS[module];
    if (!model) return res.status(400).json({ error: 'Invalid module' });
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const searchFields = { contact: ['firstName','lastName','email'], lead: ['firstName','lastName','company','email'], deal: ['name','description'], account: ['name','website'], case: ['subject','description'], product: ['name','sku','code'] };
    // Only the columns the model has: a missing one failed the whole search.
    const fields = (searchFields[model] || ['name']).filter(f => modelHasField(model, f));
    const where = await reachableWhere(req, module, model, { OR: fields.map(f => ({ [f]: { contains: q, mode: 'insensitive' } })) });
    const results = await prisma[model].findMany({ where, take: Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100), orderBy: { updatedAt: 'desc' } });
    res.json({ module, query: q, results, count: results.length });
  } catch (err) { next(err); }
});
