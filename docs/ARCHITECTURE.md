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
         Stack     (100 files) Factory   ORM     Logger    Jobs
            |          |          |        |        |          |
            +----------+----------+--------+--------+----------+
                                           |
                              +------------+------------+
                              |                         |
                        PostgreSQL 16         Redis 7, optional
                        (primary store)   (job queues, sign-outs)
```

## Request Lifecycle

Every HTTP request follows this exact path:

1. **Helmet** -- Security headers (HSTS, X-Frame-Options and others; a content security policy in production)
2. **Compression** -- Gzip response compression for bodies over 1KB
3. **Request ID** and **CORS** -- Cross-origin headers for the configured origins
4. **Body Parser** -- JSON bodies up to 1MB (10MB for documents, 2MB for AI requests)
5. **HPP and XSS filtering** -- Repeated query parameters collapsed; string values in JSON and form bodies and query strings filtered (multipart fields are not)
6. **Logging and metrics**
7. **Rate Limiter** -- Per-IP throttling on `/api` (default 1000 requests per 15 minutes, kept in memory; tighter fixed limits on sign-in)
8. **Route Matching** -- Express router dispatches to correct module
9. **JWT Authentication** -- Token verified, `req.userId` set (skipped for public routes)
10. **Permission Check** -- `requirePermission(module, level)` validates RBAC
11. **Audit Middleware** -- Injects `req.audit()` for mutation logging
12. **Route Handler** -- Business logic executes
13. **Error Handler** -- Catches and formats errors with appropriate HTTP status

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

17 of the 100 route files use createCrudRouter. The other 83 define their own routes.

Every create, update and delete of a module's records, through the factory or anywhere else, goes through `services/recordWrites.js`, which runs the module's hooks and rules before the write and audit, workflows and webhooks after it. A feature this install lacks answers 501 through `utils/unavailable.js`, with a `code` naming it; see [Feature status](FEATURE_STATUS.md).

### Route Extension Pattern

Several modules share a URL prefix by mounting multiple routers:

| Prefix | Routers | Why |
|--------|---------|-----|
| `/api/deals` | deals.js + dealExtras.js | CRUD base + contact roles, products, stage history, health, competitors |
| `/api/quotes` | quotes.js + quoteExtras.js | CRUD and line items + discounts, clone, convert to order, versions |

Express processes them in registration order. Since path patterns don't overlap, both routers serve correctly.

## Data Layer

### Prisma ORM

Prisma provides type-safe database access. The schema file (`prisma/schema.prisma`) is the single source of truth for all 286 models. Key design decisions:

**UUID primary keys** -- Every model uses `@default(cuid())` for globally unique, non-sequential IDs.

**Polymorphic relations** -- Modules like Attachment, FeedItem, and Note use `parentId + parentModule` (string) instead of dedicated foreign keys. This allows any record in any module to have attachments without schema changes.

**JSON fields** -- Complex nested data uses Prisma's `Json` type (PostgreSQL JSONB): custom field values, survey questions/answers, territory rules, flow definitions, portal themes.

**Soft deletes** -- DELETE routes move records to the RecycleBinItem table with a 30-day retention window rather than destroying data.

### Index Strategy

Indexes follow three rules:

1. **Every foreign key gets an index** -- Prisma creates these automatically for `@relation` fields.
2. **Every search path gets a composite index** -- `(parentId, parentModule)` for polymorphic lookups, `(userId, loginTime)` for login history queries.
3. **Unique constraints enforce business rules** -- `(dealId, contactId)` prevents duplicate contact roles, `(roleId, module, field)` ensures one FLS record per combination.

### Migration Strategy

`prisma/migrations` holds the initial migration and the ones added since, applied in order by `npx prisma migrate deploy` (`npm run db:migrate:prod`). The test suite builds its database the same way, so tests run on the schema production gets.

For a schema change, generate a new migration with `npx prisma migrate dev`.

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

Server-to-server integrations use API keys passed via `X-API-Key` header. Only a SHA-256 of each key is stored, and a key acts with at most the creator's permissions. Each key records when it was last used, and allows its `rateLimit` of requests per hour.

## Security Layers

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Transport | TLS (reverse proxy) | Encryption in transit |
| Headers | Helmet.js | HSTS, X-Frame-Options and others; CSP in production |
| Rate limiting | express-rate-limit | DDoS / brute-force mitigation |
| Input sanitization | xss (`middleware/sanitize.js`) | XSS filtering of JSON and form bodies and query strings |
| Password storage | bcrypt (cost 10) | Irreversible password hashing |
| Token signing | HS256 JWT | Tamper-proof auth tokens |
| Webhook signing | HMAC-SHA256 | Outbound request verification |
| Account lockout | Configurable threshold | Brute-force login prevention |
| Audit trail | AuditLog table | Record writes and audited actions, kept 90 days |
| Event logging | EventLog table | Defined; nothing writes it yet |

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

Pino structured JSON logging with configurable levels. Request logs include method, URL, status code, response time, and user ID. Audit entries are written for every record write through the write path, and by the routes that log their own actions; a weekly job deletes entries older than 90 days. Some administrative changes are not audited yet (for example MFA and SSO settings), and a write with no signed-in user, such as a web form or a job, records no entry.

### Metrics

`GET /metrics` exposes Prometheus-compatible metrics: request count, response times, active connections, error rates.

## Frontend Architecture

The React frontend lives in `frontend/src`: 55 pages, most of them in `App.jsx` (about 6,500 lines), with the landing page, shared controls, related lists and a few others in files of their own. Vite builds it into `frontend/dist`, which the API serves.

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

Shared components used across the pages: Spinner, Badge (8 color variants), Button, Input, Select, TextArea, Modal, Toast, DataTable (with pagination), StatCard, EmptyState.

## Docker Architecture

```yaml
services:
  postgres:    # PostgreSQL 16, persistent volume, health: pg_isready
  redis:       # Redis 7, persistent volume, health: redis-cli ping
  api:         # Node.js 20 Alpine, port 7544, health: /api/health
  migrate:     # One-shot: prisma migrate deploy + first administrator, then exits
```

The multi-stage Dockerfile produces a ~150MB Alpine image. The migrate service runs once on deployment to apply schema changes and create the first administrator. Production creates no demo records.

## Directory Structure

```
src/
  index.js           Server entry, port binding, graceful shutdown
  app.js             Express app, middleware stack, every route mount
  middleware/
    auth.js          JWT verification, requirePermission, API key auth
    audit.js         req.audit() helper, AuditLog writes
    rateLimit.js     Configurable rate limiter
    sanitize.js      XSS input sanitization
    validate.js      Request body validation
  routes/            100 route files (one or more per domain)
  services/          recordWrites (the one write path), approvals, mail, webhooks
  utils/
    crud.js          CRUD router factory
    unavailable.js   The 501 answer for a feature this install lacks
prisma/
  schema.prisma      286 models (single source of truth)
  migrations/        SQL migrations
  seed.js            Demo data seeder
frontend/src/
  App.jsx            Most of the 55 pages
  Landing.jsx        The public site
tests/               Jest suites (51 files)
e2e/                 Playwright browser tests and their test server
scripts/             Swagger generator, backup utility
```
