const { priceLines } = require('./quotePricing');
const { evaluate } = require('./recordRules');
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'ORDER_PRICING' }); };
async function prepareOrderLines(db, order, source) {
  source = await require('./productSelection').selectProducts(db, order, source);
  const rules = await db.priceRule.findMany({ where: { active: true }, orderBy: [{ evalOrder: 'asc' }, { id: 'asc' }] });
  const products = await db.product.findMany({ where: { id: { in: source.map(l => l.productId).filter(Boolean) }, deletedAt: null } });
  if (source.some(l => l.productId && !products.some(p => p.id === l.productId))) fail('An order product is unavailable');
  const lines = priceLines(source.map(l => ({ ...l, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discount: Number(l.discount || 0) })), rules, products);
  const subtotal = Math.round(lines.reduce((n, l) => n + l.total, 0) * 100) / 100;
  const tax = Number(order.tax || 0), discount = Number(order.discount || 0);
  if (!Number.isFinite(tax) || tax < 0 || !Number.isFinite(discount) || discount < 0 || discount > subtotal) fail('Order tax and discount are invalid');
  const total = Math.round((subtotal + tax - discount) * 100) / 100;
  const validation = await db.productRule.findMany({ where: { active: true, type: 'Validation' } });
  for (const rule of validation) if ((rule.scope === 'Product' ? lines : [{ ...order, subtotal, total, itemCount: lines.length }, ...lines]).some(l => evaluate(rule.conditions, l))) fail(rule.errorMessage || rule.name);
  return { lines, subtotal, total, totalAmount: total };
}
module.exports = { prepareOrderLines };
