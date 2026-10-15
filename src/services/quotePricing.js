const crypto = require('crypto');
const { evaluate } = require('./recordRules');
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const refuse = (message, code = 'QUOTE_PRICING') => { throw Object.assign(new Error(message), { status: 400, code }); };

function priceLines(lines, rules, products) {
  return lines.map(source => {
    const line = { ...source };
    for (const rule of rules.filter(r => r.targetObject === 'QuoteLine')) {
      if (!evaluate(rule.conditions, line)) continue;
      for (const action of rule.actions || []) {
        const value = Number(action.value);
        if (!Number.isFinite(value)) refuse(`Invalid amount in price rule ${rule.name}`);
        if (action.type === 'setPrice') line.unitPrice = value;
        else if (action.type === 'setDiscount') line.discount = value;
        else if (action.type === 'markup') {
          const product = products.find(p => p.id === line.productId);
          if (!product) refuse('Markup needs an existing product');
          line.unitPrice = money(product.price * (1 + value / 100));
        } else refuse(`Unsupported action in price rule ${rule.name}`);
      }
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitPrice) || line.unitPrice < 0 || !Number.isFinite(line.discount || 0) || (line.discount || 0) < 0 || (line.discount || 0) > line.quantity * line.unitPrice) refuse('Quote lines need positive quantities, nonnegative prices, and discounts no greater than the line amount');
    line.total = money(line.quantity * line.unitPrice - (line.discount || 0));
    return line;
  });
}

async function approvalRequired(db, quote, lines, current) {
  const gross = lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0);
  const discounted = lines.reduce((n, l) => n + (l.discount || 0), 0) + (quote.discount || 0);
  const facts = { ...quote, discountPercent: gross ? discounted / gross * 100 : 0 };
  const rules = await db.cpqApprovalRule.findMany({ where: { active: true }, orderBy: { priority: 'asc' } });
  for (const rule of rules) {
    if (!evaluate(rule.conditions, facts)) continue;
    const processId = rule.approvers?.processId;
    const approval = current?.id && processId && await db.approvalRequest.findFirst({ where: {
      module: 'quotes', recordId: current.id, processId, status: 'Approved',
      completedAt: { gte: current.pricingUpdatedAt || current.updatedAt },
    } });
    if (!approval) refuse(`Approval required: ${rule.name}. Submit this quote to the configured approval process before accepting or ordering it.`, 'QUOTE_APPROVAL_REQUIRED');
  }
}

async function prepareQuote(db, input, current, ctx) {
  const data = { ...input };
  delete data.pricingFingerprint;
  delete data.pricingUpdatedAt;
  const rules = await db.priceRule.findMany({ where: { active: true }, orderBy: [{ evalOrder: 'asc' }, { id: 'asc' }] });
  const supplied = ctx.nested?.items?.create;
  let lines = supplied || (current?.id ? await db.quoteItem.findMany({ where: { quoteId: current.id } }) : []);
  if (supplied) {
    const products = await db.product.findMany({ where: { id: { in: lines.map(l => l.productId).filter(Boolean) }, deletedAt: null }, select: { id: true, price: true } });
    lines = priceLines(lines, rules, products);
    ctx.nested = { ...ctx.nested, items: { ...ctx.nested.items, create: lines } };
  }
  const merged = { ...current, ...data };
  for (const rule of rules.filter(r => r.targetObject === 'Quote')) {
    if (!evaluate(rule.conditions, merged)) continue;
    for (const action of rule.actions || []) {
      if (action.type !== 'setDiscount' || !Number.isFinite(Number(action.value)) || Number(action.value) < 0) refuse(`Quote rule ${rule.name} must set a nonnegative discount`);
      data.discount = Number(action.value); merged.discount = data.discount;
    }
  }
  if (lines.length || supplied) {
    data.subtotal = money(lines.reduce((n, l) => n + l.total, 0));
    const discount = Number(data.discount ?? current?.discount ?? 0), tax = Number(data.tax ?? current?.tax ?? 0);
    if (!Number.isFinite(discount) || discount < 0 || discount > data.subtotal || !Number.isFinite(tax) || tax < 0) refuse('Quote tax and discount must be nonnegative; discount cannot exceed subtotal');
    data.total = data.totalAmount = money(data.subtotal - discount + tax);
  }
  const productRules = await db.productRule.findMany({ where: { active: true, type: 'Validation' }, orderBy: { sortOrder: 'asc' } });
  for (const rule of productRules) {
    const targets = rule.scope === 'Product' ? lines : [{ ...merged, ...data, itemCount: lines.length }, ...lines];
    if (targets.some(t => evaluate(rule.conditions, t))) refuse(rule.errorMessage || `Product rule failed: ${rule.name}`, 'PRODUCT_RULE');
  }

  const priced = { ...merged, ...data };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    lines: lines.map(l => [l.productId, l.quantity, l.unitPrice, l.discount || 0, l.total]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    discount: priced.discount || 0, tax: priced.tax || 0, total: priced.total || 0,
  })).digest('hex');
  const changed = !!current && (current.pricingFingerprint
    ? fingerprint !== current.pricingFingerprint
    : !!supplied || ['discount', 'tax', 'total'].some(f => data[f] != null && data[f] !== current[f]));
  data.pricingFingerprint = fingerprint;
  data.pricingUpdatedAt = !current || changed ? new Date() : current.pricingUpdatedAt || current.updatedAt;
  if (changed && ['Accepted', 'Approved'].includes(current.status) && data.status == null) data.status = 'Draft';
  if (['Accepted', 'Approved'].includes(data.status) && (data.status !== current?.status || changed)) {
    await approvalRequired(db, priced, lines, changed ? null : current);
  }
  return data;
}

module.exports = { priceLines, prepareQuote, approvalRequired };
