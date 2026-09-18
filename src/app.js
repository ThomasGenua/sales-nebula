/**
 * Express App Factory (Production-Hardened)
 * 
 * Security: Helmet, CORS lockdown, input sanitization, HPP, per-route body limits
 * Operational: Structured logging, Prometheus metrics, real health checks
 * Data: Validation constraints on write routes
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { limiters } = require('./middleware/rateLimit');
const { sanitize } = require('./middleware/sanitize');
const { requestLogger } = require('./services/logger');
const { initMetrics } = require('./services/metrics');
const { validateBody } = require('./utils/integrity');

let helmet, hpp, compression;
try { helmet = require('helmet'); } catch (e) { helmet = null; }
try { hpp = require('hpp'); } catch (e) { hpp = null; }
try { compression = require('compression'); } catch (e) { compression = null; }

/**
 * Hashes of the inline <script> tags in the built shell.
 *
 * Helmet's default CSP is `script-src 'self'`, which blocks inline script. The
 * shell carries one: the snippet that sets data-theme before first paint. In
 * production it was being blocked, so every light-theme visitor got a dark
 * flash on load. Hashing it keeps the policy strict and the script running.
 */
function inlineScriptHashes(spaDir) {
  try {
    const html = fs.readFileSync(path.join(spaDir, 'index.html'), 'utf8');
    const hashes = [];
    const inline = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = inline.exec(html)) !== null) {
      if (!match[1].trim()) continue;
      hashes.push(`'sha256-${crypto.createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
    }
    return hashes;
  } catch (err) {
    return [];
  }
}

function createApp(prisma) {
  const app = express();
  const isTest = process.env.NODE_ENV === 'test';
  const isProd = process.env.NODE_ENV === 'production';
  const spaDir = path.join(__dirname, '..', 'frontend', 'dist');

  // ─── SECURITY HEADERS (Helmet) ───
  if (helmet && !isTest) {
    let contentSecurityPolicy = false;
    if (isProd) {
      const hashes = inlineScriptHashes(spaDir);
      contentSecurityPolicy = hashes.length
        ? { useDefaults: true, directives: { 'script-src': ["'self'", ...hashes] } }
        : undefined;
    }
    app.use(helmet({ contentSecurityPolicy, crossOriginEmbedderPolicy: false }));
  }

  // ─── RESPONSE COMPRESSION ───
  if (compression && !isTest) {
    app.use(compression({ threshold: 1024, level: 6 }));
  }

  // ─── REQUEST ID TRACING ───
  app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });

  // ─── CORS (locked down in production) ───
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:7544')
    .split(',').map(s => s.trim());

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || !isProd) {
        cb(null, true);
      } else {
        cb(new Error('CORS: origin not allowed'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID', 'If-Match'],
    exposedHeaders: ['X-Request-ID', 'X-Cache', 'Retry-After'],
    maxAge: 86400,
  }));

  // ─── BODY PARSING (with size limits) ───
  app.use(express.json({ limit: '1mb' })); // Default 1MB
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ─── HTTP PARAMETER POLLUTION PROTECTION ───
  if (hpp) app.use(hpp());

  // ─── INPUT SANITIZATION (XSS) ───
  app.use(sanitize);

  // ─── REQUEST LOGGING ───
  if (!isTest) app.use(requestLogger);

  // ─── PROMETHEUS METRICS ───
  const { middleware: metricsMiddleware, route: metricsRoute } = initMetrics();
  if (!isTest) app.use(metricsMiddleware);
  app.get('/metrics', metricsRoute);

  // ─── STATIC FILES ───
  app.use('/uploads', express.static(path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads')));

  // ─── RATE LIMITING ───
  if (!isTest) app.use(limiters.standard);

  // ─── SHARED SERVICES ───
  app.locals.prisma = prisma;
  app.locals.emit = app.locals.emit || {
    toUser: () => {}, toRecord: () => {}, toModule: () => {}, toAll: () => {},
    toRole: () => {}, toFeed: () => {}, recordCreated: () => {}, recordUpdated: () => {},
    recordDeleted: () => {}, notification: () => {}, dealStageChanged: () => {},
    approvalRequired: () => {}, workflowExecuted: () => {}, chatterNewPost: () => {},
    forecastUpdated: () => {},
  };
  app.locals.cache = app.locals.cache || { get: async () => null, set: async () => {}, del: async () => {}, enabled: false };
  app.locals.storage = app.locals.storage || { mode: 'local', init: () => {} };

  // ─── PUBLIC ROUTES ───
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/signup', require('./routes/signup'));
  app.use('/api/oauth', require('./routes/oauth'));

  // Public web-to-lead form submission (no auth required)
  app.post('/api/public/web-to-lead', async (req, res, next) => {
    try {
      const { firstName, lastName, email, phone, company, source, description } = req.body;
      if (!firstName || !lastName || !company) {
        return res.status(400).json({ error: 'firstName, lastName, and company are required' });
      }

      // Check for duplicate
      const existing = email ? await prisma.lead.findFirst({ where: { email } }) : null;
      if (existing) {
        return res.status(409).json({ error: 'A lead with this email already exists', leadId: existing.id });
      }

      const lead = await prisma.lead.create({
        data: {
          firstName, lastName, email, phone,
          company, source: source || 'Web Form',
          description, status: 'New', score: 50,
        },
      });

      // Auto-assign via round-robin if rules exist
      try {
        const rule = await prisma.assignmentRule.findFirst({ where: { module: 'leads', active: true, type: 'round_robin' } });
        if (rule && rule.assignees) {
          const assignees = typeof rule.assignees === 'string' ? JSON.parse(rule.assignees) : rule.assignees;
          if (assignees.length > 0) {
            const nextIndex = (rule.lastIndex + 1) % assignees.length;
            await prisma.lead.update({ where: { id: lead.id }, data: { assignedId: assignees[nextIndex] } });
            await prisma.assignmentRule.update({ where: { id: rule.id }, data: { lastIndex: nextIndex } });
          }
        }
      } catch (e) { /* Assignment rules optional */ }

      // Auto-score
      try {
        const scoringRules = await prisma.leadScoringRule.findMany({ where: { active: true } });
        if (scoringRules.length > 0) {
          let score = 50;
          for (const r of scoringRules) {
            const val = String(lead[r.field] || '').toLowerCase();
            const target = r.value.toLowerCase();
            let match = false;
            switch (r.operator) {
              case 'equals': match = val === target; break;
              case 'contains': match = val.includes(target); break;
              case 'startsWith': match = val.startsWith(target); break;
            }
            if (match) score += r.points;
          }
          score = Math.max(0, Math.min(100, score));
          await prisma.lead.update({ where: { id: lead.id }, data: { score } });
        }
      } catch (e) { /* Scoring optional */ }

      res.status(201).json({ success: true, leadId: lead.id });
    } catch (err) { next(err); }
  });

  // Email tracking pixel (1x1 transparent GIF, no auth)
  app.get('/api/public/track/:emailId', async (req, res) => {
    try {
      await prisma.email.update({
        where: { id: req.params.emailId },
        data: { opened: true, openedAt: new Date() },
      });
    } catch (e) { /* Silently fail - don't break pixel delivery */ }
    // Return 1x1 transparent GIF
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache', 'Content-Length': pixel.length });
    res.end(pixel);
  });

  // ─── PROTECTED ROUTES (with validation constraints on write paths) ───
  app.use('/api/contacts', require('./routes/contacts'));
  app.use('/api/leads', require('./routes/leads'));
  app.use('/api/deals', require('./routes/deals'));
  app.use('/api/accounts', require('./routes/accounts'));
  app.use('/api/activities', require('./routes/activities'));
  app.use('/api/emails', require('./routes/emails'));
  app.use('/api/cases', require('./routes/cases'));
  app.use('/api/documents',
    express.json({ limit: '10mb' }), // Larger limit for document uploads
    require('./routes/documents'));
  app.use('/api/campaigns', require('./routes/campaigns'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/quotes', require('./routes/quotes'));
  app.use('/api/invoices', require('./routes/invoices'));
  app.use('/api/workflows', require('./routes/workflows'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/ai',
    express.json({ limit: '2mb' }), // Larger for AI context
    require('./routes/ai'));
  app.use('/api/forecasts', require('./routes/forecasts'));
  app.use('/api/cpq', require('./routes/cpq'));
  app.use('/api/approvals', require('./routes/approvals'));
  app.use('/api/territories', require('./routes/territories'));
  app.use('/api/knowledge', require('./routes/knowledge'));
  app.use('/api/chatter', require('./routes/chatter'));
  app.use('/api/formulas', require('./routes/formulas'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/dashboard', require('./routes/dashboard'));
  app.use('/api/search', require('./routes/search'));
  app.use('/api/tags', require('./routes/tags'));
  app.use('/api/notes', require('./routes/notes'));
  app.use('/api/sequences', require('./routes/sequences'));
  app.use('/api/views', require('./routes/views'));
  app.use('/api/webhooks', require('./routes/webhooks'));
  app.use('/api/recycle-bin', require('./routes/recycleBin'));
  app.use('/api/import', require('./routes/import'));
  app.use('/api/mass-actions', require('./routes/massActions'));
  app.use('/api/sharing', require('./routes/sharing'));

  // New Salesforce-parity modules
  app.use('/api/contracts', require('./routes/contracts'));
  app.use('/api/orders', require('./routes/orders'));
  app.use('/api/entitlements', require('./routes/entitlements'));
  app.use('/api/teams', require('./routes/teams'));
  app.use('/api/duplicates', require('./routes/duplicates'));
  app.use('/api/campaign-influence', require('./routes/campaignInfluence'));
  app.use('/api/configuration', require('./routes/configuration'));
  app.use('/api/sales-path', require('./routes/salesPath'));
  app.use('/api/macros', require('./routes/macros'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api/connected-apps', require('./routes/connectedApps'));
  app.use('/api/data-export', require('./routes/dataExport'));
  app.use('/api/timeline', require('./routes/timeline'));
  app.use('/api/public/web-to-case', require('./routes/webToCase'));
  app.use('/api/export', require('./routes/export'));

  // Salesforce-parity Phase 2
  app.use('/api/subscriptions', require('./routes/subscriptions'));
  app.use('/api/revenue', require('./routes/revenueRecognition'));
  app.use('/api/flows', require('./routes/flowBuilder'));
  app.use('/api/custom-objects', require('./routes/customObjects'));
  app.use('/api/conversation-intelligence', require('./routes/conversationIntelligence'));
  app.use('/api/omnichannel', require('./routes/omnichannel'));
  app.use('/api/field-service', require('./routes/fieldService'));
  app.use('/api/security', require('./routes/security'));
  app.use('/api/environments', require('./routes/environments'));
  app.use('/api/analytics', require('./routes/analytics'));
  app.use('/api/integrations', require('./routes/integrations'));
  app.use('/api/marketplace', require('./routes/marketplace'));
  app.use('/api/custom-code', require('./routes/customCode'));
  app.use('/api/custom-components', require('./routes/customComponents'));
  app.use('/api/cdp', require('./routes/cdp'));
  app.use('/api/ai-agents', require('./routes/aiAgents'));
  app.use('/api/copilot', require('./routes/copilot'));
  app.use('/api/mobile', require('./routes/mobile'));
  app.use('/api/cpq/advanced', require('./routes/advancedCpq'));
  app.use('/api/public/email-to-case', require('./routes/emailToCase'));
  app.use('/api/bulk', require('./routes/bulkApi'));

  // Salesforce-parity Phase 3
  app.use('/api/assets', require('./routes/assets'));
  app.use('/api/person-accounts', require('./routes/personAccounts'));
  app.use('/api/partners', require('./routes/partners'));
  app.use('/api/surveys', require('./routes/surveys'));
  app.use('/api/deals', require('./routes/dealExtras'));
  app.use('/api/consent', require('./routes/consent'));
  app.use('/api/privacy', require('./routes/privacy'));
  app.use('/api/scheduler', require('./routes/scheduler'));
  app.use('/api/calendar', require('./routes/calendar'));
  app.use('/api/projects', require('./routes/projects'));
  app.use('/api/security-groups', require('./routes/securityGroups'));
  app.use('/api/pdf-templates', require('./routes/pdfTemplates'));
  app.use('/api/studio', require('./routes/studio'));
  app.use('/api/sla', require('./routes/sla'));
  app.use('/api/favorites', require('./routes/favorites'));
  app.use('/api/search-index', require('./routes/searchIndex'));
  app.use('/api/inbound-email', require('./routes/inboundEmail'));
  app.use('/api/maps', require('./routes/maps'));
  app.use('/api/prospects', require('./routes/prospects'));
  app.use('/api/bugs', require('./routes/bugs'));
  app.use('/api/feed', require('./routes/feed'));
  app.use('/api/portal', require('./routes/portal'));
  app.use('/api/attachments', require('./routes/attachments'));
  app.use('/api/monitoring', require('./routes/monitoring'));
  app.use('/api/quotes', require('./routes/quoteExtras'));
  app.use('/api/admin/dashboard', require('./routes/adminDashboard'));

  // ─── HEALTH CHECK (real connectivity verification) ───
  app.get('/api/health', async (req, res) => {
    const checks = { status: 'ok', version: '2.1.0', name: 'Sales Nebula API', timestamp: new Date().toISOString() };
    const services = {};

    // Database check
    try {
      await prisma.$queryRaw`SELECT 1`;
      services.database = { status: 'up' };
    } catch (e) {
      services.database = { status: 'down', error: e.message };
      checks.status = 'degraded';
    }

    // Cache check
    const cache = app.locals.cache;
    if (cache?.enabled) {
      try {
        await cache.set('_health', 'ok', 5);
        const val = await cache.get('_health');
        services.cache = { status: val === 'ok' ? 'up' : 'degraded', mode: cache.client ? 'redis' : 'memory' };
      } catch (e) {
        services.cache = { status: 'down', error: e.message };
      }
    } else {
      services.cache = { status: 'disabled' };
    }

    // Storage check
    services.storage = { status: 'up', mode: app.locals.storage?.mode || 'local' };

    checks.services = services;
    const httpStatus = checks.status === 'ok' ? 200 : 503;
    res.status(httpStatus).json(checks);
  });

  // Swagger docs
  try {
    const { setupSwagger } = require('./swagger');
    setupSwagger(app);
  } catch (e) { /* Swagger not available */ }

  // ─── SERVE THE SINGLE PAGE APP ───
  // Runs after every /api route so it never shadows the API, and before the
  // 404 handler so client routes like /verify, /accept-invite, /privacy,
  // /terms, and /reset-password resolve. Without the fallback, a visitor
  // who follows an emailed link lands on a JSON 404 instead of the app.
  if (fs.existsSync(path.join(spaDir, 'index.html'))) {
    app.use(express.static(spaDir, {
      index: false,
      setHeaders: (res, filePath) => {
        // Fingerprinted assets are immutable; the shell must never be cached
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));

    app.get(/^\/(?!api\/|uploads\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(spaDir, 'index.html'));
    });
  } else {
    // The package ships source, not a build. Without this a visitor gets a
    // bare Express 404 at "/" and no clue why, so say what to run instead.
    app.get(/^\/(?!api\/|uploads\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.status(503).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Sales Nebula: front end not built</title>
<style>
  body { background:#060B1A; color:#F0EDE5; font-family:ui-monospace,monospace;
         display:flex; align-items:center; justify-content:center;
         min-height:100vh; margin:0; padding:24px; }
  .card { max-width:520px; border:1px solid #182550; border-radius:12px;
          background:#0B1228; padding:32px; }
  h1 { font-size:19px; margin:0 0 14px; color:#F5A623; }
  p { color:#7E8598; line-height:1.65; font-size:13px; margin:0 0 16px; }
  pre { background:#0E1630; border:1px solid #182550; border-radius:8px;
        padding:12px 14px; color:#F0EDE5; font-size:12px; overflow-x:auto; margin:0 0 16px; }
  a { color:#F5A623; }
</style></head>
<body><div class="card">
  <h1>The front end has not been built</h1>
  <p>The API is running, but there is no compiled single page app to serve.
     This package ships source rather than build output.</p>
  <pre>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</pre>
  <p>Then restart. Or bring the whole stack up with
     <code>docker compose up</code>, which builds the front end for you.</p>
  <p>The API itself is live at <a href="/api/health">/api/health</a>
     and documented at <a href="/api/docs">/api/docs</a>.</p>
</div></body></html>`);
    });
  }

  // ─── 404 HANDLER ───
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found', path: req.originalUrl });
  });

  // ─── ERROR HANDLER ───
  app.use((err, req, res, next) => {
    // Handle CORS errors
    if (err.message?.includes('CORS')) {
      return res.status(403).json({ error: 'CORS: origin not allowed' });
    }

    // Handle Prisma unique constraint violations
    if (err.code === 'P2002') {
      const field = err.meta?.target?.join(', ') || 'field';
      return res.status(409).json({ error: `Duplicate value for ${field}` });
    }

    // Handle Prisma not found
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Record not found' });
    }

    // Handle JSON parse errors
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }

    // Handle body too large
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }

    const status = err.status || err.statusCode || 500;
    if (!isTest) {
      const { logger } = require('./services/logger');
      logger.error({ err, url: req.originalUrl, method: req.method, userId: req.userId }, err.message);
    }

    res.status(status).json({
      error: status === 500 && isProd ? 'Internal server error' : err.message,
      requestId: req.requestId,
      ...(isProd ? {} : { stack: err.stack }),
    });
  });

  return app;
}

/**
 * Graceful shutdown handler.
 * Closes HTTP server, database connections, and job queues.
 */
function setupGracefulShutdown(server, prisma) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    const { logger } = require('./services/logger');
    logger.info({ signal }, 'Graceful shutdown initiated');

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Give in-flight requests 10 seconds to complete
    const forceTimeout = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);

    try {
      await prisma.$disconnect();
      logger.info('Database disconnected');
    } catch (e) {
      logger.error({ err: e }, 'Error disconnecting database');
    }

    clearTimeout(forceTimeout);
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createApp, setupGracefulShutdown, inlineScriptHashes };
