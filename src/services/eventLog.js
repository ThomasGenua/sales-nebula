const { logger } = require('./logger');

/**
 * API requests in the EventLog table, which /api/monitoring reads: the call
 * and error counts, response times and the event search. Nothing wrote the
 * table, so the counts were always 0 and the search always empty.
 *
 * One row a request under /api, held in memory and written in batches, so a
 * request never waits on its row or fails with it. A row keeps the route
 * (/api/leads/:id), not the path: a path can carry a secret (a calendar
 * feed's, a shared quote's or an invitation's token), and a query string
 * search terms. The record's id, when the route names one, is kept apart.
 */

const FLUSH_MS = 5000;
const BATCH = 500;
// With the database slow or down, rows past this many are dropped rather
// than held without bound.
const MAX_PENDING = 10000;
// A load balancer's health checks would be most of the rows.
const SKIPPED = new Set(['/api/health']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route a request matched, as its pattern. Answered inside its router,
 * baseUrl is that router's mount; an error passed on to the app's handler has
 * left the router, and only the module's part of the path is known. With no
 * route matched, that part alone: the rest is whatever was sent.
 */
function routeOf(req, path) {
  const prefix = path.split('/').slice(0, 3).join('/');
  const pattern = req.route ? String(req.route.path) : '';
  const route = !pattern ? prefix : pattern.startsWith('/api/') ? pattern : `${req.baseUrl || prefix}${pattern}`;
  return route.length > 1 ? route.replace(/\/$/, '') : route;
}

function createEventLog(prisma, { flushMs = FLUSH_MS } = {}) {
  let pending = [];
  let timer = null;
  let dropped = 0;
  let draining = null;

  // One drain at a time: rows that arrive while a batch is being written wait
  // in `pending` for the next one, which bounds what is held in memory.
  function flush() {
    if (!draining) draining = drain().finally(() => { draining = null; });
    return draining;
  }

  async function drain() {
    clearTimeout(timer);
    timer = null;
    while (pending.length) {
      const rows = pending.splice(0, BATCH);
      try {
        await prisma.eventLog.createMany({ data: rows });
      } catch (err) {
        logger.warn({ error: err.message, rows: rows.length }, 'Event log write failed; these API events are not recorded');
      }
    }
    if (dropped) {
      logger.warn({ dropped }, 'Event log fell behind; API events were dropped');
      dropped = 0;
    }
  }

  function record(row) {
    if (pending.length >= MAX_PENDING) { dropped += 1; return; }
    pending.push(row);
    if (pending.length >= BATCH) flush();
    else if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, flushMs);
      timer.unref?.();
    }
  }

  function middleware(req, res, next) {
    const path = req.originalUrl.split('?')[0];
    if (SKIPPED.has(path)) return next();
    const timestamp = new Date();
    const started = process.hrtime.bigint();
    res.on('finish', () => record({
      eventType: 'API',
      timestamp,
      userId: req.userId || null,
      sourceIp: req.ip || null,
      uri: routeOf(req, path).slice(0, 500),
      method: req.method,
      statusCode: res.statusCode,
      responseTime: Number((process.hrtime.bigint() - started) / 1000000n),
      module: path.split('/')[2] || null,
      recordId: UUID.test(req.params?.id || '') ? req.params.id : null,
    }));
    next();
  }

  return { middleware, record, flush };
}

module.exports = { createEventLog };
