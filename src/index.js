require('dotenv').config();
const http = require('http');

const { cache } = require('./services/cache');
const { initWebSocket, emit } = require('./services/websocket');
const { storage } = require('./services/storage');
const { initJobQueue } = require('./jobs/scheduler');
const { logger } = require('./services/logger');
const { setRedisClient } = require('./middleware/auth');

const { createApp } = require('./app');
const { createDatabaseClient } = require('./database');

let prisma;
let server;

// ─── STARTUP ───
async function start() {
  const PORT = process.env.PORT || 7544;

  logger.info('Starting Sales Nebula API...');

  const database = await createDatabaseClient();
  prisma = database.prisma;

  const app = createApp(prisma);
  server = http.createServer(app);

  // Override stubs with real services
  app.locals.emit = emit;
  app.locals.cache = cache;
  app.locals.storage = storage;
  app.locals.databaseProvider = database.provider;

  // Job and presence routes live in their routers (routes/admin.js,
  // routes/users.js). Copies registered here came after the app's /api 404
  // handler and so never answered.

  // Initialize services (with graceful degradation)
  try { await cache.connect(); } catch (e) { logger.warn({ error: e.message }, 'Cache init failed, continuing without cache'); }

  // Share Redis client with auth for token blacklist
  if (cache.client) setRedisClient(cache.client);

  try { storage.init(); } catch (e) { logger.warn({ error: e.message }, 'Storage init failed, using local'); }
  try { initWebSocket(server, prisma); } catch (e) { logger.warn({ error: e.message }, 'WebSocket init failed'); }
  try { initJobQueue(prisma); } catch (e) { logger.warn({ error: e.message }, 'Job queue init failed'); }

  server.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' },
      `Sales Nebula API v2.1 running on http://localhost:${PORT}`);
    logger.info(`  Health:    http://localhost:${PORT}/api/health`);
    logger.info(`  Docs:      http://localhost:${PORT}/api/docs`);
    logger.info(`  Metrics:   http://localhost:${PORT}/metrics`);
    logger.info(`  WebSocket: ws://localhost:${PORT}`);
  });
}

start().catch(err => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});

// Graceful shutdown
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  if (server) server.close();
  if (prisma) await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
