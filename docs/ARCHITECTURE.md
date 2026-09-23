# Sales Nebula CRM -- Architecture Guide

## System Architecture

```
                                    Load Balancer / Nginx
                                           |
                                    Express API Server
                                    (Node.js 20, Alpine)
                                           |
            +----------+----------+--------+--------+----------+
            |          |          |        |        |          |
        Middleware   Routes    CRUD     Prisma   Audit    Background
         Stack      (86 files) Factory   ORM     Logger    Jobs
            |          |          |        |        |          |
            +----------+----------+--------+--------+----------+
                                           |
                              +------------+------------+
                              |                         |
                        PostgreSQL 16              Redis 7
                        (primary store)         (cache, queues)
```

## Request Lifecycle

Every HTTP request follows this exact path:

1. **CORS** -- Cross-origin headers applied (configurable allowed origins)
2. **Helmet** -- 15 security headers injected (CSP, HSTS, X-Frame-Options, etc.)
3. **Compression** -- Gzip response compression for bodies > 1KB
4. **Body Parser** -- JSON body parsing with 10MB limit
5. **Rate Limiter** -- Per-IP throttling (default: 200 req/15 min)
6. **XSS Sanitizer** -- All string inputs in request body sanitized
7. **Route Matching** -- Express router dispatches to correct module
8. **JWT Authentication** -- Token verified, `req.userId` set (skipped for public routes)
9. **Permission Check** -- `requirePermission(module, level)` validates RBAC
10. **Audit Middleware** -- Injects `req.audit()` for mutation logging
11. **Route Handler** -- Business logic executes
12. **Error Handler** -- Catches and formats errors with appropriate HTTP status

## Module System

### CRUD Router Factory (`src/utils/crud.js`)

The heart of the system. A single function call generates a complete REST module with 7 standard endpoints:

```javascript
module.exports = createCrudRouter('deal', 'deals', {
  include: { account: true, contact: true },  // Prisma relations to load
  searchFilter: (q) => ({ name: { contains: q } }),  // How search works
  validate: (data) => { ... },  // Pre-save validation
  beforeCreate: async (data, req) => data,  // Transform before insert
  afterUpdate: async (record, req) => { ... },  // Side effects after update
  customRoutes: (router) => { ... },  // Additional endpoints
  orderBy: { updatedAt: 'desc' },  // Default sort
});
```

**Generated endpoints:** GET / (paginated list), GET /:id, POST /, PUT /:id, DELETE /:id (soft delete), plus search and field selection.

17 modules use createCrudRouter. The remaining 69 define custom routes.

### Route Extension Pattern

Several modules share a URL prefix by mounting multiple routers:

| Prefix | Routers | Why |
|--------|---------|-----|
| `/api/deals` | deals.js + dealExtras.js | CRUD base + contact roles, splits, history |
| `/api/quotes` | quotes.js + quoteExtras.js | CRUD + templates, line items |

Express processes them in registration order. Since path patterns don't overlap, both routers serve correctly.

## Data Layer

### Prisma ORM

Prisma provides type-safe database access. The schema file (`prisma/schema.prisma`) is the single source of truth for all 173 models. Key design decisions:

**UUID primary keys** -- Every model uses `@default(cuid())` for globally unique, non-sequential IDs.

**Polymorphic relations** -- Modules like Attachment, FeedItem, and Note use `parentId + parentModule` (string) instead of dedicated foreign keys. This allows any record in any module to have attachments without schema changes.

**JSON fields** -- Complex nested data uses Prisma's `Json` type (PostgreSQL JSONB): custom field values, survey questions/answers, territory rules, flow definitions, portal themes.

**Soft deletes** -- DELETE routes move records to the RecycleBinItem table with a 30-day retention window rather than destroying data.

### Index Strategy (253 indexes)

Indexes follow three rules:

1. **Every foreign key gets an index** -- Prisma creates these automatically for `@relation` fields.
2. **Every search path gets a composite index** -- `(parentId, parentModule)` for polymorphic lookups, `(userId, loginTime)` for login history queries.
3. **Unique constraints enforce business rules** -- `(dealId, contactId)` prevents duplicate contact roles, `(roleId, module, field)` ensures one FLS record per combination.

### Migration Strategy

A single atomic migration (`00000000000000_initial/migration.sql`) creates all 173 tables. This means:

- Fresh deployments always get a consistent schema
- No migration ordering issues
- The migration file is the canonical reference for the physical schema

For incremental changes, generate new migrations with `npx prisma migrate dev`.

## Authentication Architecture

### Token Strategy

Dual JWT tokens with different lifetimes:

| Token | TTL | Purpose | Browser storage |
|-------|-----|---------|-----------------|
| Access | 15 min | API authorization | httpOnly cookie `sn_access` (path `/api`) |
| Refresh | 7 days | Token renewal | httpOnly cookie `sn_refresh` (path `/api/auth`, SameSite=Strict) |

The short access token TTL limits exposure from token theft. The refresh token allows long sessions without re-authentication.

The browser never holds either token where a script could read it
(`src/utils/sessionCookies.js`). Cookie-authenticated requests that change
state must carry the `sn_csrf` cookie's value in `X-CSRF-Token`
(double-submit). Scripts and integrations use Bearer tokens or API keys, which
need no CSRF token. Only tokens of type `access` authenticate, and signing out
revokes the refresh token as well as the access token.

### RBAC Model

```
User --[1:1]--> Role --[1:many]--> Permission
                                      |
                              module: "deals"
                              level: "read" | "edit" | "full"
```

Permission levels are cumulative: `full` implies `edit` which implies `read`. The `requirePermission(module, level)` middleware checks the user's role permissions on every request.

### API Key Authentication

Server-to-server integrations use API keys passed via `X-API-Key` header. Keys are stored as bcrypt hashes and inherit the creator's permissions. Each key tracks last-used timestamp and request count.

## Security Layers

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Transport | TLS (reverse proxy) | Encryption in transit |
| Headers | Helmet.js | CSP, HSTS, X-Frame-Options, 12 more |
| Rate limiting | express-rate-limit | DDoS / brute-force mitigation |
| Input sanitization | xss-clean | XSS prevention on all inputs |
| Password storage | bcrypt (cost 10) | Irreversible password hashing |
| Token signing | HS256 JWT | Tamper-proof auth tokens |
| Webhook signing | HMAC-SHA256 | Outbound request verification |
| Account lockout | Configurable threshold | Brute-force login prevention |
| Audit trail | AuditLog table | Complete mutation history |
| Event logging | EventLog table | API call tracking with risk scoring |

## Operational Architecture

### Health Check

`GET /api/health` returns:
- Database connectivity (Prisma raw query)
- Process uptime
- Heap memory usage (alert threshold: 500MB)
- Node.js version
- Timestamp

Docker Compose health checks poll this every 30 seconds.

### Graceful Shutdown

On SIGTERM or SIGINT:
1. Stop accepting new connections
2. Drain in-flight requests (10-second timeout)
3. Disconnect Prisma client
4. Exit with code 0

This enables zero-downtime deploys with rolling restarts.

### Logging

Pino structured JSON logging with configurable levels. Request logs include method, URL, status code, response time, and user ID. Audit logs capture every create/update/delete with before/after values.

### Metrics

`GET /metrics` exposes Prometheus-compatible metrics: request count, response times, active connections, error rates.

## Frontend Architecture

The React frontend is a single-file SPA (`frontend/App.jsx`, 1,756 lines) with 28 pages.

### State Management

No external state library. The app uses:
- `AuthContext` for authentication state (token, user, login/logout/register)
- `useApi()` custom hook for data fetching with loading/error/refresh
- Component-level `useState` for UI state

### Design System

Bloomberg Terminal aesthetic with a carefully defined color hierarchy:

| Token | Hex | Role |
|-------|-----|------|
| Base | #060B1A | Page background |
| Surface | #0B1228 | Cards, panels |
| Interactive | #0E1630 | Hover states |
| Border | #182550 | Dividers |
| Accent | #F5A623 | Primary CTA, active states |
| Text primary | #F0EDE5 | Headings |
| Text secondary | #C8C2B4 | Body text |
| Text muted | #7E8598 | Labels |

### Component Library

8 shared components used across all pages: Spinner, Badge (8 color variants), Button, Input, Select, TextArea, Modal, Toast, DataTable (with pagination), StatCard, EmptyState.

## Docker Architecture

```yaml
services:
  postgres:    # PostgreSQL 16, persistent volume, health: pg_isready
  redis:       # Redis 7, persistent volume, health: redis-cli ping
  api:         # Node.js 20 Alpine, port 4000, health: /api/health
  migrate:     # One-shot: prisma migrate + seed, then exits
```

The multi-stage Dockerfile produces a ~150MB Alpine image. The migrate service runs once on deployment to apply schema changes and seed initial data.

## Directory Structure

```
src/
  index.js           Server entry, port binding, graceful shutdown
  app.js             Express app, middleware stack, 86 route mounts
  middleware/
    auth.js          JWT verification, requirePermission, API key auth
    audit.js         req.audit() helper, AuditLog writes
    rateLimit.js     Configurable rate limiter
    sanitize.js      XSS input sanitization
    validate.js      Request body validation
  routes/            86 route modules (one per domain)
  utils/
    crud.js          CRUD router factory
prisma/
  schema.prisma      173 models (single source of truth)
  migrations/        SQL migrations
  seed.js            Demo data seeder
frontend/
  App.jsx            Complete React SPA (1,756 lines, 28 pages)
tests/               Jest test suites (246 tests)
scripts/             Swagger generator, backup utility
```
