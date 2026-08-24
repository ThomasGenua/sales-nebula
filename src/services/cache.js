/**
 * Redis Cache Service
 * Provides caching for expensive queries (dashboard stats, report results, etc.)
 * Falls back to in-memory Map if Redis is not available.
 */

let Redis;
try { Redis = require('ioredis'); } catch (e) { Redis = null; }

class CacheService {
  constructor() {
    this.client = null;
    this.fallback = new Map();
    this.ttlMap = new Map(); // For fallback TTL tracking
    this.enabled = false;
  }

  async connect() {
    if (!process.env.REDIS_URL || !Redis) {
      console.log('  Cache: Using in-memory fallback (set REDIS_URL for Redis)');
      this.enabled = true;
      return;
    }
    try {
      this.client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      this.client.on('error', (err) => {
        console.error('Redis error:', err.message);
        this.client = null; // Fallback to memory
      });
      await this.client.ping();
      this.enabled = true;
      console.log('  Cache: Redis connected');
    } catch (err) {
      console.log('  Cache: Redis unavailable, using in-memory fallback');
      this.client = null;
      this.enabled = true;
    }
  }

  async get(key) {
    if (this.client) {
      const val = await this.client.get(key);
      return val ? JSON.parse(val) : null;
    }
    // Fallback: check TTL
    const ttl = this.ttlMap.get(key);
    if (ttl && Date.now() > ttl) {
      this.fallback.delete(key);
      this.ttlMap.delete(key);
      return null;
    }
    return this.fallback.get(key) || null;
  }

  async set(key, value, ttlSeconds = 300) {
    if (this.client) {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } else {
      this.fallback.set(key, value);
      this.ttlMap.set(key, Date.now() + ttlSeconds * 1000);
    }
  }

  async del(key) {
    if (this.client) {
      await this.client.del(key);
    } else {
      this.fallback.delete(key);
      this.ttlMap.delete(key);
    }
  }

  async invalidatePattern(pattern) {
    if (this.client) {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) await this.client.del(...keys);
    } else {
      for (const key of this.fallback.keys()) {
        if (key.includes(pattern.replace('*', ''))) {
          this.fallback.delete(key);
          this.ttlMap.delete(key);
        }
      }
    }
  }

  async flush() {
    if (this.client) await this.client.flushdb();
    else { this.fallback.clear(); this.ttlMap.clear(); }
  }
}

const cache = new CacheService();

// Express middleware: cache GET responses
function cacheMiddleware(ttl = 300, keyPrefix = '') {
  return async (req, res, next) => {
    if (req.method !== 'GET' || !cache.enabled) return next();
    const key = `${keyPrefix}:${req.originalUrl}:${req.userId || 'anon'}`;
    try {
      const cached = await cache.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(cached);
      }
    } catch (e) { /* continue without cache */ }

    // Monkey-patch res.json to capture and cache the response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode === 200) {
        cache.set(key, data, ttl).catch(() => {});
      }
      res.set('X-Cache', 'MISS');
      return originalJson(data);
    };
    next();
  };
}

module.exports = { cache, cacheMiddleware };
