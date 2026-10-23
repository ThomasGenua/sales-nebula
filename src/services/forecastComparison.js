const categories = ['Pipeline', 'Best Case', 'Commit', 'Closed'];
const effective = item => item?.overrideAmount ?? item?.amount ?? 0;

// Compare only records still visible to the caller. Never disclose a removed
// record just because its id or former amount survived in a snapshot.
function compareSnapshots(before, after, visibleDeals) {
  if (before.currency !== after.currency) throw Object.assign(new Error('Snapshots use different currencies'), { status: 400 });
  const visible = new Map(visibleDeals.map(d => [d.id, d]));
  const index = snapshot => new Map((snapshot.items || []).filter(i => visible.has(i.dealId) && i.category !== 'Omitted').map(i => [i.dealId, i]));
  const a = index(before), b = index(after);
  const changes = [...new Set([...a.keys(), ...b.keys()])].sort().flatMap(id => {
    const old = a.get(id), current = b.get(id);
    const delta = effective(current) - effective(old);
    if (old && current && !delta && old.category === current.category) return [];
    return [{ dealId: id, name: visible.get(id).name, kind: !old ? 'Added' : !current ? 'Removed' : 'Changed',
      beforeCategory: old?.category ?? null, afterCategory: current?.category ?? null,
      beforeAmount: effective(old), afterAmount: effective(current), delta }];
  });
  const totals = map => Object.fromEntries(categories.map(c => [c, [...map.values()].filter(i => i.category === c).reduce((n, i) => n + effective(i), 0)]));
  const beforeTotals = totals(a), afterTotals = totals(b);
  return { currency: after.currency, beforeId: before.id, afterId: after.id, beforeTotals, afterTotals,
    deltas: Object.fromEntries(categories.map(c => [c, afterTotals[c] - beforeTotals[c]])), changes };
}
module.exports = { compareSnapshots };
