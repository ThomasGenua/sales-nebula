const { evaluate } = require('./recordRules');
const refuse = message => { throw Object.assign(new Error(message), { status: 400, code: 'PRODUCT_SELECTION' }); };
async function selectProducts(db, quote, supplied) {
  let lines = supplied.map(l => ({ ...l }));
  const rules = await db.productRule.findMany({ where: { active: true, type: { in: ['Selection', 'Filter'] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  for (const rule of rules) {
    if (![{ ...quote, itemCount: lines.length }, ...lines].some(f => evaluate(rule.conditions, f))) continue;
    for (const action of rule.actions || []) {
      if (rule.type === 'Filter') {
        if (action.type !== 'excludeProduct') refuse('Filter rules must exclude a product');
        if (lines.some(l => l.productId === action.productId)) refuse(rule.errorMessage || `${rule.name}: product is excluded`);
      } else {
        if (action.type !== 'selectProduct') refuse('Selection rules must select a product');
        if (lines.some(l => l.productId === action.productId)) continue;
        const product = await db.product.findFirst({ where: { id: action.productId, deletedAt: null } });
        if (!product) refuse('Selected product is unavailable');
        const quantity = action.quantity ?? 1;
        if (!Number.isInteger(quantity) || quantity < 1) refuse('Selected quantity must be a positive integer');
        lines.push({ productId: product.id, description: product.name, quantity, unitPrice: product.price, discount: 0, total: quantity * product.price });
      }
    }
  }
  if (lines.length > 500) refuse('At most 500 lines are supported');
  return lines;
}
function ruleProblem(kind, rule) {
  if (typeof rule.name !== 'string' || !rule.name.trim()) return 'A rule name is required';
  if (!Array.isArray(rule.conditions) || rule.conditions.length > 50 || !Array.isArray(rule.actions) || rule.actions.length > 50) return 'Use at most 50 conditions and actions';
  const operators = ['equals','notEquals','gt','gte','lt','lte','contains','isEmpty','isNotEmpty','in','notIn'];
  if (rule.conditions.some(c => !c || typeof c.field !== 'string' || !operators.includes(c.operator))) return 'Invalid condition';
  if (kind === 'price') {
    if (!['Quote','QuoteLine'].includes(rule.targetObject)) return 'Choose Quote or QuoteLine';
    if (rule.actions.some(a => !['setPrice','setDiscount','markup'].includes(a.type) || typeof a.value !== 'number' || !Number.isFinite(a.value) || a.value < 0 || rule.targetObject === 'Quote' && a.type !== 'setDiscount')) return 'Invalid price action';
  } else {
    if (!['Validation','Alert','Selection','Filter'].includes(rule.type)) return 'Invalid product rule type';
    if (['Selection','Filter'].includes(rule.type) && rule.actions.some(a => a.type !== (rule.type === 'Selection' ? 'selectProduct' : 'excludeProduct') || typeof a.productId !== 'string' || !a.productId || a.quantity != null && (!Number.isInteger(a.quantity) || a.quantity < 1))) return 'Choose products and positive quantities';
  }
  return null;
}
module.exports = { selectProducts, ruleProblem };
