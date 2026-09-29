/**
 * Human-readable record numbers: CS-001, ORD-0001, CON-0001, QT-001, INV-001.
 *
 * Every one of these columns is @unique, and they used to come from
 * count() + 1 alone. That hands out a number twice after any hard delete, and
 * two creates racing each other both pick the same one; either way the second
 * insert dies on the unique index. Several creates supplied no number at all,
 * so Prisma refused them outright.
 *
 * So: start at count() + 1, jump past the highest number in use when that one
 * is taken, and when a concurrent insert still wins the race, pick again.
 *
 * Picking again is not enough when many creates arrive together: each round
 * only one of them wins, so with the old five attempts the sixth and later of
 * eight simultaneous quotes failed with "Duplicate value for number". Creates
 * of one kind now take turns within a process, which removes nearly all the
 * clashes, and the retry (twelve attempts, each after a random pause so racers
 * from other processes do not collide in step) covers the rest.
 */

const MAX_ATTEMPTS = 12;

/** A random pause, longer each attempt. */
const pause = attempt => new Promise(resolve => setTimeout(resolve, Math.random() * 20 * attempt));

// One chain of pending creates per kind of record, in this process.
const turns = new Map();

/** Run `task` after every earlier one for `key` has finished, however it ended. */
function inTurn(key, task) {
  const run = (turns.get(key) || Promise.resolve()).then(task);
  turns.set(key, run.catch(() => {}));
  return run;
}

const format = (prefix, n, width) => `${prefix}${String(n).padStart(width, '0')}`;

/** The next number not in use, e.g. `CS-042`. */
async function nextFreeNumber(prisma, delegate, { field, prefix, width = 4 }) {
  const model = prisma[delegate];
  const candidate = format(prefix, (await model.count()) + 1, width);
  const taken = await model.findFirst({ where: { [field]: candidate }, select: { id: true } });
  if (!taken) return candidate;

  // Rows were deleted below count() + 1. Carry on from the highest number
  // in use rather than probing upward one query at a time.
  // Only numbers in this format count: parseInt read the seed's
  // "INV-2025-001" as 2025, so the next invoice after a clash was INV-2026.
  const rows = await model.findMany({ where: { [field]: { startsWith: prefix } }, select: { [field]: true } });
  const highest = rows.reduce((max, r) => {
    const digits = String(r[field]).slice(prefix.length);
    const n = /^\d+$/.test(digits) ? parseInt(digits, 10) : NaN;
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return format(prefix, highest + 1, width);
}

const isClashOn = (err, field) =>
  err?.code === 'P2002' && [].concat(err.meta?.target || []).some(t => String(t).includes(field));

/**
 * `prisma[delegate].create(args)` with `args.data[field]` filled in.
 * Not for use inside an interactive transaction: Postgres aborts the whole
 * transaction on the unique violation, so there is nothing left to retry in.
 */
function createNumbered(prisma, delegate, numbering, args) {
  return inTurn(`${delegate}.${numbering.field}`, async () => {
    for (let attempt = 1; ; attempt++) {
      const number = await nextFreeNumber(prisma, delegate, numbering);
      try {
        return await prisma[delegate].create({ ...args, data: { ...args.data, [numbering.field]: number } });
      } catch (err) {
        if (!isClashOn(err, numbering.field) || attempt >= MAX_ATTEMPTS) throw err;
        await pause(attempt);
      }
    }
  });
}

// The formats the seed data and the old count() + 1 code already used.
const CASE_NUMBER = { field: 'caseNumber', prefix: 'CS-', width: 3 };
const ORDER_NUMBER = { field: 'orderNumber', prefix: 'ORD-', width: 4 };
const CONTRACT_NUMBER = { field: 'contractNumber', prefix: 'CON-', width: 4 };
const SUBSCRIPTION_NUMBER = { field: 'subscriptionNumber', prefix: 'SUB-', width: 4 };
const WORK_ORDER_NUMBER = { field: 'workOrderNumber', prefix: 'WO-', width: 4 };
const QUOTE_NUMBER = { field: 'number', prefix: 'QT-', width: 3 };
const INVOICE_NUMBER = { field: 'number', prefix: 'INV-', width: 3 };

module.exports = {
  nextFreeNumber, createNumbered,
  CASE_NUMBER, ORDER_NUMBER, CONTRACT_NUMBER, SUBSCRIPTION_NUMBER, WORK_ORDER_NUMBER,
  QUOTE_NUMBER, INVOICE_NUMBER,
};
