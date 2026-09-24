/**
 * Money in more than one currency.
 *
 * A deal carries its own currency code; one with none (null) counts as the
 * organisation's default, the Currency row marked isDefault. Every total is
 * reported in that default: each deal's value is divided by its currency's
 * exchangeRate, which counts units of that currency per one unit of the
 * default (the convention the Currency table and /api/admin/currencies/convert
 * already use), at the rate in force when the total is taken.
 *
 * The migration that added the column stamped existing deals with the
 * default, so every existing total comes out exactly as it did.
 */

const CACHE_MS = 60000;
let cache = { value: null, expires: 0 };

/** The default currency, the rates, and a converter into the default. */
async function currencyContext(prisma) {
  if (cache.value && cache.expires > Date.now()) return cache.value;
  const rows = await prisma.currency.findMany({ select: { code: true, name: true, symbol: true, exchangeRate: true, isDefault: true, active: true } });
  const base = rows.find(r => r.isDefault)?.code || 'USD';
  const byCode = new Map(rows.map(r => [r.code, r]));
  const value = {
    base,
    baseSymbol: byCode.get(base)?.symbol || '$',
    currencies: rows,
    /** An amount in `code`, in the default currency. */
    toBase(amount, code) {
      const n = Number(amount) || 0;
      if (!code || code === base) return n;
      const rate = byCode.get(code)?.exchangeRate;
      // A currency still on a deal cannot be deleted (see admin.js), so a
      // missing rate means one was removed behind the API's back; the amount
      // is then counted as if it were already in the default.
      return rate > 0 ? n / rate : n;
    },
  };
  cache = { value, expires: Date.now() + CACHE_MS };
  return value;
}

/** Call after any change to the Currency table. */
function invalidateCurrencyCache() { cache = { value: null, expires: 0 }; }

/** Sum of `field` over deals, in the default currency. */
function sumInBase(deals, ctx, field = 'value') {
  return deals.reduce((total, d) => total + ctx.toBase(d[field], d.currency), 0);
}

/**
 * Total and count of deal values matching `where`, in the default currency:
 * one database sum per currency, converted, then added.
 */
async function dealTotalInBase(prisma, where) {
  const ctx = await currencyContext(prisma);
  const groups = await prisma.deal.groupBy({ by: ['currency'], where, _sum: { value: true }, _count: { _all: true } });
  return {
    value: groups.reduce((total, g) => total + ctx.toBase(g._sum.value || 0, g.currency), 0),
    count: groups.reduce((total, g) => total + g._count._all, 0),
  };
}

/**
 * The currency code a deal write should store: an active Currency code,
 * upper-cased, with an empty value meaning the default. The code is always
 * stored explicitly, so a later change of default currency cannot quietly
 * re-denominate existing deals. Throws a 400 for anything else.
 */
async function resolveDealCurrency(prisma, code) {
  const ctx = await currencyContext(prisma);
  if (code === undefined || code === null || code === '') return ctx.base;
  const upper = String(code).trim().toUpperCase();
  // The default always stands, as an empty value does: with no Currency rows
  // yet (the default is then USD) an explicit "USD" was refused.
  if (upper === ctx.base) return upper;
  const known = ctx.currencies.find(c => c.code === upper && c.active);
  if (!known) throw Object.assign(new Error(`Unknown or inactive currency: ${code}`), { status: 400 });
  return upper;
}

module.exports = { currencyContext, invalidateCurrencyCache, sumInBase, dealTotalInBase, resolveDealCurrency };
