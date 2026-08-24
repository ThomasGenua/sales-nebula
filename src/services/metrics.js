/**
 * Prometheus Metrics
 * Exposes /metrics endpoint for monitoring.
 * Tracks: request duration, counts, active connections, error rates, business metrics.
 */

let promClient;
try { promClient = require('prom-client'); } catch (e) { promClient = null; }

let metrics = null;

function initMetrics() {
  if (!promClient) {
    return {
      middleware: (req, res, next) => next(),
      route: (req, res) => res.status(503).send('prom-client not installed'),
    };
  }

  // Collect default Node.js metrics (memory, CPU, event loop)
  promClient.collectDefaultMetrics({ prefix: 'sn_' });

  const httpDuration = new promClient.Histogram({
    name: 'sn_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

  const httpTotal = new promClient.Counter({
    name: 'sn_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
  });

  const httpErrors = new promClient.Counter({
    name: 'sn_http_errors_total',
    help: 'Total HTTP errors (4xx + 5xx)',
    labelNames: ['method', 'route', 'status'],
  });

  const activeConnections = new promClient.Gauge({
    name: 'sn_active_connections',
    help: 'Active HTTP connections',
  });

  const wsConnections = new promClient.Gauge({
    name: 'sn_websocket_connections',
    help: 'Active WebSocket connections',
  });

  const dbQueryDuration = new promClient.Histogram({
    name: 'sn_db_query_duration_seconds',
    help: 'Database query duration',
    labelNames: ['operation', 'model'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  });

  const cacheHits = new promClient.Counter({
    name: 'sn_cache_hits_total',
    help: 'Cache hit count',
  });

  const cacheMisses = new promClient.Counter({
    name: 'sn_cache_misses_total',
    help: 'Cache miss count',
  });

  const authFailures = new promClient.Counter({
    name: 'sn_auth_failures_total',
    help: 'Authentication failure count',
    labelNames: ['reason'],
  });

  const jobsExecuted = new promClient.Counter({
    name: 'sn_jobs_executed_total',
    help: 'Background jobs executed',
    labelNames: ['job', 'status'],
  });

  metrics = {
    httpDuration, httpTotal, httpErrors, activeConnections,
    wsConnections, dbQueryDuration, cacheHits, cacheMisses,
    authFailures, jobsExecuted,
  };

  // Middleware to track request metrics
  function middleware(req, res, next) {
    activeConnections.inc();
    const end = httpDuration.startTimer();

    res.on('finish', () => {
      const route = req.route?.path || req.path || 'unknown';
      const labels = { method: req.method, route, status: res.statusCode };

      end(labels);
      httpTotal.inc(labels);
      activeConnections.dec();

      if (res.statusCode >= 400) {
        httpErrors.inc(labels);
      }
    });

    next();
  }

  // /metrics endpoint
  function route(req, res) {
    res.set('Content-Type', promClient.register.contentType);
    promClient.register.metrics().then(data => res.send(data));
  }

  return { middleware, route, metrics };
}

function getMetrics() { return metrics; }

module.exports = { initMetrics, getMetrics };
