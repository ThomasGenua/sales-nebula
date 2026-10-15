const { buildIndexEntry, projectRecord, MODULE_INDEX_MAP } = require('../utils/searchIndex');
const { resolveModel } = require('./workflowEngine');

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


async function enqueueIndex(db, module, recordId, operation = 'upsert') {
  if (MODULE_INDEX_MAP[module]) await db.searchIndexQueue.upsert({ where: { module_recordId_operation: { module, recordId, operation } }, create: { module, recordId, operation }, update: { attempts: 0, lastError: null } });
}
async function drainIndex(db, limit = 200) {
  const items = await db.searchIndexQueue.findMany({ where: { attempts: { lt: 5 } }, orderBy: { createdAt: 'asc' }, take: limit });
  let processed = 0;
  for (const item of items) {
    try {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "SearchIndexQueue" WHERE id = ${item.id} FOR UPDATE`;
        if (!await tx.searchIndexQueue.findUnique({ where: { id: item.id } })) return;
        const model = resolveModel(item.module);
        // Read current state, even for delete events: a restore may have happened.
        const record = model && await tx[model].findUnique({ where: { id: item.recordId } });
        if (record && !record.deletedAt) await indexRecord(tx, item.module, record);
        else {
          const entries = await tx.searchIndex.findMany({ where: { module: item.module, recordId: item.recordId }, select: { id: true } });
          await tx.searchPosting.deleteMany({ where: { indexId: { in: entries.map(e => e.id) } } });
          await tx.searchIndex.deleteMany({ where: { module: item.module, recordId: item.recordId } });
        }
        await tx.searchIndexQueue.delete({ where: { id: item.id } });
      });
      processed++;
    } catch (err) {
      await db.searchIndexQueue.updateMany({ where: { id: item.id }, data: { attempts: { increment: 1 }, lastError: String(err.message).slice(0, 300) } });
    }
  }
  if (processed) await refreshTermStats(db);
  return { processed, failed: items.length - processed };
}
module.exports = { indexRecord, refreshTermStats, enqueueIndex, drainIndex };
