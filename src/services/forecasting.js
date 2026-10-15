const { currencyContext, sumInBase } = require('../utils/currency');
const { categoryFor } = require('../utils/forecastCategory');

const periodWhere = f => ({ ownerId: f.userId, deletedAt: null, closeDate: { gte: f.periodStart, lte: f.periodEnd } });

async function snapshot(db, forecast, reason, ctx) {
  const items = await db.forecastItem.findMany({ where: { forecastId: forecast.id }, select: { dealId: true, amount: true, category: true, overrideAmount: true } });
  const won = await db.deal.findMany({ where: { ...periodWhere(forecast), stage: 'Closed Won' }, select: { id: true, value: true, currency: true } });
  return db.forecastSnapshot.create({ data: {
    forecastId: forecast.id, userId: forecast.userId, period: forecast.period,
    reason, currency: ctx.base, quota: forecast.quotaAmount,
    items: [...items.map(i => i.category === 'Closed' ? { ...i, category: 'Omitted' } : i), ...won.map(d => ({ dealId: d.id, category: 'Closed', amount: ctx.toBase(d.value, d.currency), overrideAmount: null }))],
  } });
}

async function refreshForecast(prisma, id, reason = 'Refresh') {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT id FROM "Forecast" WHERE id = ${id} FOR UPDATE`;
    const forecast = await db.forecast.findUnique({ where: { id }, include: { items: true } });
    if (!forecast || forecast.status !== 'Open') return forecast;
    const ctx = await currencyContext(db);
    const deals = await db.deal.findMany({ where: { ...periodWhere(forecast), stage: { notIn: ['Closed Won', 'Closed Lost'] } } });
    const ids = deals.map(d => d.id);
    // Includes deleted, reassigned, closed, and slipped-out deals. Overrides
    // survive refresh only while the deal remains in this forecast's scope.
    await db.forecastItem.deleteMany({ where: { forecastId: id, dealId: { notIn: ids } } });
    const existing = new Map(forecast.items.map(i => [i.dealId, i]));
    for (const deal of deals) {
      const item = existing.get(deal.id);
      const data = { amount: ctx.toBase(deal.value, deal.currency), probability: deal.probability, closeDate: deal.closeDate };
      if (item) await db.forecastItem.update({ where: { id: item.id }, data });
      else await db.forecastItem.create({ data: { ...data, forecastId: id, dealId: deal.id, category: categoryFor(deal.probability) } });
    }
    const items = await db.forecastItem.findMany({ where: { forecastId: id } });
    const sum = categories => items.filter(i => categories.includes(i.category)).reduce((n, i) => n + (i.overrideAmount ?? i.amount), 0);
    const won = await db.deal.findMany({ where: { ...periodWhere(forecast), stage: 'Closed Won' }, select: { value: true, currency: true } });
    const updated = await db.forecast.update({ where: { id }, data: {
      commit: sum(['Commit']), bestCase: sum(['Commit', 'Best Case']),
      pipeline: sum(['Pipeline', 'Best Case', 'Commit']), closed: sumInBase(won, ctx),
    } });
    await snapshot(db, updated, reason, ctx);
    return updated;
  }, { timeout: 30000 });
}

module.exports = { refreshForecast, snapshot };
