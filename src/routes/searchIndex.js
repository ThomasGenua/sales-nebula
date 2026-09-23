const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const {
  buildIndexEntry, projectRecord, parseQuery, rankResults,
  buildSnippet, tokenize, expandSynonyms, suggestCorrections,
  MODULE_INDEX_MAP,
} = require('../utils/searchIndex');

const router = Router();

const MODEL_FOR = {
  contacts: 'contact', leads: 'lead', accounts: 'account', deals: 'deal',
  cases: 'case', products: 'product', quotes: 'quote', invoices: 'invoice',
  contracts: 'contract', documents: 'document', projects: 'project',
  campaigns: 'campaign', prospects: 'prospect', bugs: 'bug',
};

// The permission each indexed module answers to, where it is not its own.
const PERMISSION_FOR = { prospects: 'leads', bugs: 'cases' };
const permissionModule = module => PERMISSION_FOR[module] || module;

/**
 * The index entries whose record this user may read. The index holds a copy
 * of every record's title and text, and search, suggestions and snippets
 * answered from all of it: other reps' contacts, deals and cases, emails and
 * phone numbers included.
 */
async function readableEntries(req, entries) {
  const byModule = new Map();
  for (const entry of entries) {
    if (!byModule.has(entry.module)) byModule.set(entry.module, []);
    byModule.get(entry.module).push(entry);
  }
  const keep = new Set();
  for (const [module, list] of byModule) {
    const model = MODEL_FOR[module];
    const permission = permissionModule(module);
    if (!model || !permits(req, permission, 'read')) continue;
    const ids = [...new Set(list.map(e => e.recordId))];
    const visible = await req.app.locals.prisma[model].findMany({
      where: await reachableWhere(req, permission, model, { id: { in: ids } }),
      select: { id: true },
    });
    const allowed = new Set(visible.map(v => v.id));
    for (const entry of list) if (allowed.has(entry.recordId)) keep.add(entry);
  }
  return entries.filter(entry => keep.has(entry));
}

/** Write one record's index entry and its postings. */
async function indexRecord(prisma, module, record) {
  const projected = projectRecord(module, record);
  if (!projected) return { indexed: false, reason: 'no title' };

  const entry = buildIndexEntry({ ...projected, boost: 1.0 });
  const { postings, uniqueTerms, ...indexFields } = entry;

  const existing = await prisma.searchIndex.findFirst({ where: { module, recordId: record.id } });

  let indexId;
  if (existing) {
    await prisma.searchIndex.update({
      where: { id: existing.id },
      data: { ...indexFields, recordUpdatedAt: record.updatedAt || null, indexedAt: new Date(), deletedAt: null },
    });
    indexId = existing.id;
    await prisma.searchPosting.deleteMany({ where: { indexId } });
  } else {
    const created = await prisma.searchIndex.create({
      data: { ...indexFields, recordUpdatedAt: record.updatedAt || null },
    });
    indexId = created.id;
  }

  if (postings.length) {
    await prisma.searchPosting.createMany({
      data: postings.map(p => ({ indexId, term: p.term, field: p.field, frequency: p.frequency, positions: p.positions })),
    });
  }

  return { indexed: true, indexId, terms: uniqueTerms, postings: postings.length };
}

/** Keep the corpus-level term statistics current. */
async function refreshTermStats(prisma) {
  const grouped = await prisma.searchPosting.groupBy({ by: ['term'], _count: { indexId: true }, _sum: { frequency: true } });
  await prisma.searchTermStat.deleteMany({});
  const batch = grouped.map(g => ({ term: g.term, docCount: g._count.indexId, totalFreq: g._sum.frequency || 0 }));
  for (let i = 0; i < batch.length; i += 500) {
    await prisma.searchTermStat.createMany({ data: batch.slice(i, i + 500) }).catch(() => {});
  }
  return batch.length;
}

// ── SEARCH ────────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const prisma = req.app.locals.prisma;
    const { q, modules, limit = 20, offset = 0, snippet = 'true' } = req.query;

    if (!q || String(q).trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const parsed = parseQuery(q);
    if (!parsed.terms.length && !parsed.prefixes.length) {
      return res.json({ query: q, total: 0, results: [], message: 'Query contained only stop words' });
    }

    // Widen the term set through the synonym table
    let terms = parsed.terms;
    try {
      const synonyms = await prisma.searchSynonym.findMany({ where: { OR: [{ term: { in: terms } }, { synonym: { in: terms } }] } });
      if (synonyms.length) terms = expandSynonyms(terms, synonyms);
    } catch { /* synonyms are optional */ }

    // Prefix expansion resolves against indexed terms, not a table scan
    if (parsed.prefixes.length) {
      for (const prefix of parsed.prefixes) {
        const matches = await prisma.searchTermStat.findMany({ where: { term: { startsWith: prefix } }, take: 20, orderBy: { docCount: 'desc' } });
        terms.push(...matches.map(m => m.term));
      }
      terms = [...new Set(terms)];
    }

    // Hit the indexed term column instead of scanning every table
    const postings = await prisma.searchPosting.findMany({
      where: { term: { in: terms } },
      take: 5000,
    });
    if (!postings.length) {
      const vocabulary = (await prisma.searchTermStat.findMany({ select: { term: true }, take: 2000 })).map(t => t.term);
      const corrections = parsed.terms.flatMap(t => suggestCorrections(t, vocabulary));
      return res.json({ query: q, total: 0, results: [], didYouMean: [...new Set(corrections)].slice(0, 3), durationMs: Date.now() - startedAt });
    }

    const indexIds = [...new Set(postings.map(p => p.indexId))];
    const indexWhere = { id: { in: indexIds }, deletedAt: null };
    const moduleFilter = modules ? String(modules).split(',') : (parsed.filters.module ? [parsed.filters.module] : null);
    if (moduleFilter) indexWhere.module = { in: moduleFilter };
    if (parsed.filters.owner) indexWhere.ownerId = parsed.filters.owner;
    if (parsed.filters.status) indexWhere.status = parsed.filters.status;

    const documents = await readableEntries(req, await prisma.searchIndex.findMany({ where: indexWhere, take: 2000 }));
    const byIndexId = new Map(documents.map(d => [d.id, d]));

    const postingsByIndex = new Map();
    for (const p of postings) {
      if (!byIndexId.has(p.indexId)) continue;
      if (!postingsByIndex.has(p.indexId)) postingsByIndex.set(p.indexId, []);
      postingsByIndex.get(p.indexId).push({ ...p, positions: p.positions });
    }

    const candidates = [...postingsByIndex.entries()].map(([indexId, list]) => {
      const doc = byIndexId.get(indexId);
      return {
        indexId, module: doc.module, recordId: doc.recordId,
        title: doc.title, subtitle: doc.subtitle, body: doc.body,
        ownerId: doc.ownerId, status: doc.status,
        tokenCount: doc.tokenCount, boost: doc.boost,
        postings: list,
      };
    });

    const [totalDocs, avgAgg, stats] = await Promise.all([
      prisma.searchIndex.count({ where: { deletedAt: null } }),
      prisma.searchIndex.aggregate({ _avg: { tokenCount: true } }),
      prisma.searchTermStat.findMany({ where: { term: { in: terms } } }),
    ]);
    const docFrequencies = Object.fromEntries(stats.map(s => [s.term, s.docCount]));

    const ranked = rankResults(candidates, { ...parsed, terms }, {
      totalDocs: totalDocs || 1,
      avgTokenCount: avgAgg._avg.tokenCount || 100,
      docFrequencies,
      limit: Math.min(+limit + +offset, 200),
    });

    const page = ranked.slice(+offset, +offset + Math.min(+limit, 100));
    const results = page.map(r => ({
      module: r.module, recordId: r.recordId, title: r.title, subtitle: r.subtitle,
      score: r.score, coverage: r.coverage,
      snippet: snippet === 'true' && r.body ? buildSnippet(r.body, terms) : null,
      url: `/${r.module}/${r.recordId}`,
    }));

    const byModule = {};
    for (const r of ranked) byModule[r.module] = (byModule[r.module] || 0) + 1;

    const durationMs = Date.now() - startedAt;
    prisma.searchQueryLog.create({
      data: { userId: req.user.id, query: String(q), normalized: terms.join(' '), resultCount: ranked.length, durationMs },
    }).catch(() => {});

    res.json({
      query: q, parsed: { terms, phrases: parsed.phrases.map(p => p.text), excluded: parsed.excluded, filters: parsed.filters },
      total: ranked.length, returned: results.length, offset: +offset,
      byModule, durationMs, results,
    });
  } catch (err) { next(err); }
});

// Type-ahead: title prefix only, tuned for latency
router.get('/suggest', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, limit = 8 } = req.query;
    if (!q || String(q).trim().length < 2) return res.json([]);

    const term = String(q).trim();
    const matches = await prisma.searchIndex.findMany({
      where: { deletedAt: null, title: { startsWith: term, mode: 'insensitive' } },
      select: { module: true, recordId: true, title: true, subtitle: true },
      take: Math.min(+limit, 20),
      orderBy: { boost: 'desc' },
    });

    if (matches.length < +limit) {
      const contains = await prisma.searchIndex.findMany({
        where: { deletedAt: null, title: { contains: term, mode: 'insensitive' }, NOT: { title: { startsWith: term, mode: 'insensitive' } } },
        select: { module: true, recordId: true, title: true, subtitle: true },
        take: +limit - matches.length,
      });
      matches.push(...contains);
    }

    const readable = await readableEntries(req, matches);
    res.json(readable.map(m => ({ ...m, url: `/${m.module}/${m.recordId}` })));
  } catch (err) { next(err); }
});

// Record which result a user opened, to measure ranking quality
router.post('/click', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { query, module, recordId, rank } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const recent = await prisma.searchQueryLog.findFirst({
      where: { userId: req.user.id, query }, orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      await prisma.searchQueryLog.update({
        where: { id: recent.id },
        data: { clickedModule: module, clickedRecordId: recordId, clickedRank: rank != null ? +rank : null },
      });
    }
    res.json({ recorded: true });
  } catch (err) { next(err); }
});

// ── INDEX MANAGEMENT ──────────────────────────────────────────────────

router.post('/index/:module/:recordId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const model = MODEL_FOR[req.params.module];
    if (!model) return res.status(400).json({ error: `Module ${req.params.module} is not indexable` });
    // A record the caller can change; anyone could (re)index any record.
    const permission = permissionModule(req.params.module);
    if (!permits(req, permission, 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${permission}` });

    const record = await prisma[model].findFirst({ where: await reachableWhere(req, permission, model, { id: req.params.recordId }, 'Edit') });
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const result = await indexRecord(prisma, req.params.module, record);
    res.json(result);
  } catch (err) { next(err); }
});

// Dropping entries is index management; anyone could empty the index.
router.delete('/index/:module/:recordId', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entry = await prisma.searchIndex.findFirst({ where: { module: req.params.module, recordId: req.params.recordId } });
    if (!entry) return res.json({ removed: 0 });
    await prisma.searchPosting.deleteMany({ where: { indexId: entry.id } });
    await prisma.searchIndex.delete({ where: { id: entry.id } });
    res.json({ removed: 1 });
  } catch (err) { next(err); }
});

// Full or per-module rebuild
router.post('/reindex', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, batchSize = 500, clear } = req.body;
    const targets = module ? [module] : Object.keys(MODULE_INDEX_MAP);

    if (clear) {
      await prisma.searchPosting.deleteMany({});
      await prisma.searchIndex.deleteMany({ ...(module && { where: { module } }) });
    }

    const summary = [];
    for (const m of targets) {
      const model = MODEL_FOR[m];
      if (!model) continue;
      let indexed = 0, skipped = 0, cursor = 0;
      try {
        while (cursor < 20000) {
          const records = await prisma[model].findMany({ where: { deletedAt: null }, skip: cursor, take: Math.min(+batchSize, 1000) });
          if (!records.length) break;
          for (const record of records) {
            const r = await indexRecord(prisma, m, record);
            if (r.indexed) indexed++; else skipped++;
          }
          cursor += records.length;
          if (records.length < Math.min(+batchSize, 1000)) break;
        }
      } catch (e) {
        summary.push({ module: m, error: String(e.message).slice(0, 120) });
        continue;
      }
      summary.push({ module: m, indexed, skipped });
    }

    const termCount = await refreshTermStats(prisma);
    res.json({ modules: summary, totalIndexed: summary.reduce((s, x) => s + (x.indexed || 0), 0), uniqueTerms: termCount });
  } catch (err) { next(err); }
});

// Queue-based incremental indexing, drained by a worker or by this call
router.post('/queue/drain', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const items = await prisma.searchIndexQueue.findMany({ orderBy: { createdAt: 'asc' }, take: Math.min(parseInt(req.body.limit, 10) || 200, 1000) });

    let processed = 0, failed = 0;
    for (const item of items) {
      try {
        if (item.operation === 'delete') {
          const entry = await prisma.searchIndex.findFirst({ where: { module: item.module, recordId: item.recordId } });
          if (entry) {
            await prisma.searchPosting.deleteMany({ where: { indexId: entry.id } });
            await prisma.searchIndex.delete({ where: { id: entry.id } });
          }
        } else {
          const model = MODEL_FOR[item.module];
          const record = model ? await prisma[model].findUnique({ where: { id: item.recordId } }) : null;
          if (record) await indexRecord(prisma, item.module, record);
        }
        await prisma.searchIndexQueue.delete({ where: { id: item.id } });
        processed++;
      } catch (e) {
        failed++;
        await prisma.searchIndexQueue.update({
          where: { id: item.id },
          data: { attempts: { increment: 1 }, lastError: String(e.message).slice(0, 300) },
        }).catch(() => {});
      }
    }

    const remaining = await prisma.searchIndexQueue.count();
    res.json({ processed, failed, remaining });
  } catch (err) { next(err); }
});

router.post('/queue', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, operation } = req.body;
    if (!module || !recordId) return res.status(400).json({ error: 'module and recordId required' });
    const item = await prisma.searchIndexQueue.create({ data: { module, recordId, operation: operation || 'upsert' } });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

router.post('/stats/refresh', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const count = await refreshTermStats(req.app.locals.prisma);
    res.json({ termsUpdated: count });
  } catch (err) { next(err); }
});

// ── SYNONYMS ──────────────────────────────────────────────────────────

router.get('/synonyms', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const synonyms = await prisma.searchSynonym.findMany({ orderBy: { term: 'asc' } });
    res.json(synonyms);
  } catch (err) { next(err); }
});

router.post('/synonyms', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { term, synonym, twoWay } = req.body;
    if (!term || !synonym) return res.status(400).json({ error: 'term and synonym required' });

    const a = tokenize(term)[0];
    const b = tokenize(synonym)[0];
    if (!a || !b) return res.status(400).json({ error: 'term and synonym must contain a searchable word' });
    if (a === b) return res.status(400).json({ error: 'term and synonym normalize to the same word' });

    const created = await prisma.searchSynonym.create({ data: { term: a, synonym: b, twoWay: twoWay !== false } });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.delete('/synonyms/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    await req.app.locals.prisma.searchSynonym.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────

router.get('/analytics', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 86400000);

    const [indexSize, postingCount, termCount, logs] = await Promise.all([
      prisma.searchIndex.count({ where: { deletedAt: null } }),
      prisma.searchPosting.count(),
      prisma.searchTermStat.count(),
      prisma.searchQueryLog.findMany({ where: { createdAt: { gte: since } }, take: 5000, orderBy: { createdAt: 'desc' } }),
    ]);

    const byModule = await prisma.searchIndex.groupBy({ by: ['module'], where: { deletedAt: null }, _count: true });

    const queryCounts = {};
    for (const l of logs) {
      const key = (l.normalized || l.query).toLowerCase();
      queryCounts[key] = (queryCounts[key] || 0) + 1;
    }
    const topQueries = Object.entries(queryCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([query, count]) => ({ query, count }));
    const zeroResult = logs.filter(l => l.resultCount === 0);
    const clicked = logs.filter(l => l.clickedRecordId);

    res.json({
      indexedDocuments: indexSize,
      postings: postingCount,
      uniqueTerms: termCount,
      avgPostingsPerDoc: indexSize ? +(postingCount / indexSize).toFixed(1) : 0,
      byModule: byModule.map(m => ({ module: m.module, documents: m._count })),
      periodDays: days,
      totalQueries: logs.length,
      avgDurationMs: logs.length ? Math.round(logs.reduce((s, l) => s + l.durationMs, 0) / logs.length) : 0,
      zeroResultRate: logs.length ? +((zeroResult.length / logs.length) * 100).toFixed(1) : 0,
      clickThroughRate: logs.length ? +((clicked.length / logs.length) * 100).toFixed(1) : 0,
      avgClickRank: clicked.length ? +(clicked.reduce((s, l) => s + (l.clickedRank || 0), 0) / clicked.length).toFixed(1) : null,
      topQueries,
      topZeroResultQueries: [...new Set(zeroResult.map(l => l.query))].slice(0, 10),
    });
  } catch (err) { next(err); }
});

router.get('/health', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const coverage = [];
    for (const [module, model] of Object.entries(MODEL_FOR)) {
      try {
        const total = await prisma[model].count({ where: { deletedAt: null } });
        const indexed = await prisma.searchIndex.count({ where: { module, deletedAt: null } });
        coverage.push({ module, records: total, indexed, coveragePercent: total ? +((indexed / total) * 100).toFixed(1) : 100, stale: Math.max(0, total - indexed) });
      } catch { /* module may not exist */ }
    }
    const queueDepth = await prisma.searchIndexQueue.count();
    const failing = await prisma.searchIndexQueue.count({ where: { attempts: { gte: 3 } } });

    res.json({
      coverage,
      totalStale: coverage.reduce((s, c) => s + c.stale, 0),
      queueDepth, failingItems: failing,
      healthy: coverage.every(c => c.coveragePercent > 90) && failing === 0,
    });
  } catch (err) { next(err); }
});

module.exports = router;
