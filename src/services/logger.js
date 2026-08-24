/**
 * Structured Logging with Pino
 * JSON output in production, pretty-printed in development.
 * Provides child loggers per module and request-scoped logging.
 */

let pino;
try { pino = require('pino'); } catch (e) { pino = null; }

function createLogger(options = {}) {
  if (!pino) {
    // Fallback to console with structure
    const fallback = {
      info: (obj, msg) => console.log(JSON.stringify({ level: 'info', ...asObj(obj), msg: msg || obj })),
      warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', ...asObj(obj), msg: msg || obj })),
      error: (obj, msg) => console.error(JSON.stringify({ level: 'error', ...asObj(obj), msg: msg || obj })),
      debug: (obj, msg) => { if (process.env.NODE_ENV === 'development') console.debug(JSON.stringify({ level: 'debug', ...asObj(obj), msg: msg || obj })); },
      fatal: (obj, msg) => console.error(JSON.stringify({ level: 'fatal', ...asObj(obj), msg: msg || obj })),
      child: (bindings) => {
        const child = { ...fallback };
        child._bindings = bindings;
        return child;
      },
    };
    return fallback;
  }

  const isProd = process.env.NODE_ENV === 'production';
  const isTest = process.env.NODE_ENV === 'test';

  return pino({
    level: isTest ? 'silent' : (process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')),
    ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }),
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        userId: req.userId,
        ip: req.ip || req.headers?.['x-forwarded-for'],
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
      err: pino.stdSerializers.err,
    },
    ...options,
  });
}

function asObj(v) { return typeof v === 'object' && v !== null ? v : {}; }

const logger = createLogger();

// Express middleware: request logging
function requestLogger(req, res, next) {
  const start = Date.now();
  const reqId = req.headers['x-request-id'] || require('crypto').randomUUID();
  req.id = reqId;
  req.log = logger.child({ reqId });

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    req.log[level]({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      userId: req.userId || null,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.substring(0, 100),
    }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}

module.exports = { logger, createLogger, requestLogger };
