# Sales Nebula CRM

A full-stack enterprise CRM platform with 100% Salesforce feature parity. Built with Node.js, Express, Prisma, and PostgreSQL on the backend, with a React frontend in a Bloomberg Terminal-inspired dark aesthetic.


## Running it

Two paths, both of which end with the public site at `/` and the product at `/app`.

**Docker, one command:**

```bash
docker compose up
```

The image builds the front end during the Docker build, so nothing else is needed.

**Locally:**

```bash
npm run setup        # deps, .env, Prisma, seed, and the front end build
npm start            # API and public site on :7544
```

`npm run setup` now ends with `npm run build:frontend`. If you skip that step,
the API still runs but `/` returns a 503 page telling you what to run. Build
output lives in `frontend/dist` and is deliberately not committed.

For front end work, run the Vite dev server against the API:

```bash
npm run build        # compile the React app
npm start            # site and API together on :7544
```

Sign in at `/login`. The seeded administrator is `thomas@salesnebula.com`
with the password from `prisma/seed.js`. Staff credentials are never
pre-filled on the public login form.

Shared demo access is always available from the login screen:
`demo@salesnebula.com` / `Demo1234!`. Demo mode runs entirely in the browser
with local sample data, requires no API or database, and is read-only.

In development, when `DATABASE_URL` is not set or PostgreSQL cannot be
reached, the API creates and uses `data/sales-nebula.sqlite`. With
`NODE_ENV=production` it never falls back on its own: it retries PostgreSQL
(`DB_CONNECT_ATTEMPTS`, default 5, with backoff) and then exits, so a database
blip cannot bring the app up on an empty SQLite file. Set
`ALLOW_SQLITE_FALLBACK=true` to allow the fallback in production anyway, for
example on a single-machine demo.

## At a Glance

| Metric | Count |
|--------|-------|
| Database models | 173 |
| API endpoints | 576+ |
| Route modules | 86 |
| Database indexes | 253 |
| Frontend pages | 28 |
| Automated tests | 246 |

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Modules](#modules)
- [API Reference](#api-reference)
- [Authentication and Authorization](#authentication-and-authorization)
- [Configuration](#configuration)
- [Database](#database)
- [Testing](#testing)
- [Deployment](#deployment)
- [Frontend](#frontend)
- [Project Structure](#project-structure)
- [Additional Documentation](#additional-documentation)

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+ (optional, for caching and job queues)

### Local Development

```bash
# Clone and install
git clone <repo-url> && cd sales-nebula-backend
npm install

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL, JWT_SECRET, etc.

# Initialize database and seed data
npm run setup

# Start development server
npm run dev
```

The API starts on `http://localhost:7544`. The seed script creates a demo admin user (`thomas@salesnebula.com` / `password123`), sample roles, contacts, leads, deals, and accounts.

### Docker (Recommended for Production)

```bash
# Set required secrets
export JWT_SECRET="your-production-secret"

# Start all services (Postgres, Redis, API)
docker compose up -d

# The migrate service runs automatically on first boot
# API available at http://localhost:7544
```

Docker Compose provisions PostgreSQL 16 with persistent volumes, Redis 7 for caching, the API server with health checks, and a one-shot migration container that applies schema and seeds demo data on first boot.

---

## Architecture

```
Client (React SPA)
    |
    v
Express API Server (Node.js)
    |-- JWT Authentication
    |-- Role-Based Access Control (RBAC)
    |-- Rate Limiting (configurable per-window)
    |-- XSS Sanitization (all inputs)
    |-- Helmet Security Headers
    |-- Gzip Compression
    |-- Pino Structured Logging
    |-- Audit Logging (every mutation)
    |
    v
Prisma ORM (type-safe, generated client)
    |
    v
PostgreSQL 16            Redis 7
(primary data store)     (cache, sessions, job queues)
```

### Key Design Decisions

**Prisma ORM** handles all database operations with type-safe queries, migrations, and a generated client. The schema (`prisma/schema.prisma`) is the single source of truth for all 173 models and 253 indexes.

**CRUD Router Factory** (`src/utils/crud.js`) generates standardized REST endpoints for any module in a single function call. Each generated router includes paginated listing, full-text search, field selection, sorting, audit logging, soft deletes, and permission checks. Modules requiring custom logic extend the base router via hooks: `beforeCreate`, `afterUpdate`, `validate`, `searchFilter`, and `customRoutes`.

**Middleware Stack** is applied in this order: CORS, Helmet (15 security headers), gzip compression, JSON body parsing, rate limiting, XSS sanitization. After that, route-level middleware handles JWT authentication, permission checks, and audit logging.

**Soft Deletes** route records through the Recycle Bin with a 30-day retention window before permanent deletion. The recycle bin supports search, restore, and manual purge.

---

## Modules

Sales Nebula covers the complete Salesforce ecosystem across all major clouds. Every Salesforce standard object and add-on product has a corresponding implementation.

### Sales Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Leads | `/api/leads` | Lead capture, scoring, assignment rules, web-to-lead |
| Contacts | `/api/contacts` | Contact management with account relationships |
| Accounts | `/api/accounts` | B2B account hierarchy, team assignments |
| Person Accounts | `/api/person-accounts` | B2C individual accounts |
| Deals (Opportunities) | `/api/deals` | Full pipeline with stages, probability, line items, forecasting, clone, competitors, win/loss analysis, aging, velocity |
| Deal Extras | `/api/deals` | Contact roles, revenue splits, stage history |
| Products | `/api/products` | Product catalog with SKUs, bundles, discount schedules |
| Quotes | `/api/quotes` | Quote generation, line items, PDF export, accept/reject |
| Quote Extras | `/api/quotes` | Templates (HTML header/body/footer), line item management with auto-calculated totals |
| Orders | `/api/orders` | Order processing and fulfillment tracking |
| Contracts | `/api/contracts` | Contract lifecycle management |
| Invoices | `/api/invoices` | Invoice generation from quotes with line items |
| Forecasts | `/api/forecasts` | Revenue forecasting, quota management, forecast items |
| Territories | `/api/territories` | Territory models (Planning/Active/Archived), hierarchical territories, assignment rules, account mapping |
| Sales Path | `/api/sales-path` | Guided selling stages with coaching content |
| CPQ | `/api/cpq` | Configure-Price-Quote: bundles, pricebooks, price calculation |
| Advanced CPQ | `/api/cpq/advanced` | Product rules, price rules, guided selling, discount schedules with tier calculation, quote validation |

### Service Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Cases | `/api/cases` | Case management with comments, escalation, priority routing |
| Email-to-Case | `/api/public/email-to-case` | Inbound email auto-creates cases (webhook; requires `EMAIL_TO_CASE_SECRET`) |
| Web-to-Case | `/api/public/web-to-case` | Web form submission creates cases (public, no auth) |
| Knowledge | `/api/knowledge` | Articles with categories, versioning, attachments, search |
| Entitlements | `/api/entitlements` | Service entitlements with milestones |
| SLA Policies | (via configuration) | Service level agreements with response/resolution targets |
| Omnichannel | `/api/omnichannel` | Work routing, agent presence/capacity, skill-based assignment |
| Field Service | `/api/field-service` | Work orders, line items, service appointments, scheduling |
| Macros | `/api/macros` | Automated multi-step action sequences |

### Marketing Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Campaigns | `/api/campaigns` | Campaign management with members, recipients, target lists, ROI tracking |
| Campaign Influence | `/api/campaign-influence` | Multi-touch revenue attribution models |
| Email Templates | `/api/emails` | Template management, sync, sending |
| Email Sequences | `/api/sequences` | Multi-step drip campaigns with enrollment tracking |

### Experience Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Portal | `/api/portal` | Portal config (Customer/Partner/Employee), themes, self-registration |
| Portal Users | `/api/portal/:id/users` | User provisioning with bcrypt password hashing |
| Chatter | `/api/chatter` | Posts, comments, likes, mentions (legacy) |
| Feed | `/api/feed` | Activity feed: text/link/content/poll posts, likes, pins, comments |

### Platform

| Module | Endpoint | Description |
|--------|----------|-------------|
| Custom Objects | `/api/custom-objects` | Dynamic schema: create objects with typed fields, store records as JSONB |
| Custom Fields | (via configuration) | Extend any module with text, number, date, picklist, lookup fields |
| Validation Rules | (via configuration) | Formula-based data validation on any module |
| Record Types | (via configuration) | Multiple record type layouts per module |
| Page Layouts | (via configuration) | Field arrangement and section configuration |
| Formula Fields | `/api/formulas` | Calculated fields with cross-object references |
| Flows | `/api/flows` | Visual flow builder: definitions, versions (Draft/Active), execution history |
| Workflows | `/api/workflows` | Rule-based automation: field updates, email alerts, tasks |
| Approvals | `/api/approvals` | Multi-step approval processes with configurable approvers |
| Platform Events | `/api/events` | Pub/sub event bus with subscriptions |
| Environments | `/api/environments` | Sandbox creation, metadata export/import, change sets |
| Custom Code | `/api/custom-code` | Server-side scripts (Apex-equivalent) |
| Custom Components | `/api/custom-components` | UI component registry (Lightning-equivalent) |

### Analytics and AI

| Module | Endpoint | Description |
|--------|----------|-------------|
| Reports | `/api/reports` | Report builder with types, folders, scheduling, export |
| Analytics | `/api/analytics` | Datasets and interactive dashboards |
| Dashboard | `/api/dashboard` | Executive KPI dashboard with pipeline, activities, forecasts |
| AI Agents | `/api/ai-agents` | Configurable agents with Anthropic Claude integration and execution history |
| Copilot | `/api/copilot` | Conversational AI assistant with message threading |
| Conversation Intelligence | `/api/conversation-intelligence` | Call recording upload, transcription, sentiment analysis |
| Lead Scoring | (via configuration) | Rule-based automatic lead scoring |

### Data and Integration

| Module | Endpoint | Description |
|--------|----------|-------------|
| Import | `/api/import` | CSV/Excel import wizard with field mapping, validation, error reporting |
| Export | `/api/export` + `/api/data-export` | Data export in CSV, JSON, XLSX formats |
| Bulk API | `/api/bulk` | High-volume batch insert/update/delete/upsert operations |
| Webhooks | `/api/webhooks` | Outbound webhooks with HMAC-SHA256 signing, exponential retry, delivery logs |
| Integrations | `/api/integrations` | Third-party integration configuration and credential storage |
| Connected Apps | `/api/connected-apps` | OAuth2 client application management |
| OAuth Provider | `/api/oauth` | OAuth2 authorization server (authorization code grant) |
| Marketplace | `/api/marketplace` | App listings, installs, reviews (public browsing, auth for install) |
| CDP | `/api/cdp` | Customer Data Platform: data streams, unified profiles, segments |

### Security and Compliance

| Module | Endpoint | Description |
|--------|----------|-------------|
| Users | `/api/users` | Full CRUD, role assignment, activate/deactivate, preferences, online status |
| Roles and Permissions | `/api/users/roles` | Role CRUD with per-module permission levels (read/edit/full) |
| Sharing Rules | `/api/sharing` | Record sharing rules and org-wide defaults |
| Field-Level Security | (via configuration) | Per-field read/edit permissions by role |
| Org-Wide Defaults | (via configuration) | Default record visibility (Private/Public Read/Public Read-Write) |
| SSO | `/api/security` | SAML 2.0 and OIDC configuration |
| MFA | `/api/security` | TOTP and SMS multi-factor authentication |
| Encryption (Shield) | `/api/security` | Platform encryption policies and key management |
| Consent | `/api/consent` | GDPR consent records with opt-in/opt-out, self-service opt-out endpoint |
| Monitoring | `/api/monitoring` | Login history, event logs, 24h summary |
| Admin Dashboard | `/api/admin/dashboard` | System health, record counts, security metrics, revenue pipeline, recent activity |
| Audit Log | `/api/admin/audit-log` | Complete immutable change history (action, module, record, user, timestamp) |
| Recycle Bin | `/api/recycle-bin` | 30-day soft delete recovery with search and restore |
| Duplicate Management | `/api/duplicates` | Configurable duplicate detection rules, match results, merge |

### Other Modules

| Module | Endpoint | Description |
|--------|----------|-------------|
| Activities | `/api/activities` | Tasks, calls, meetings, events with multi-who support |
| Timeline | `/api/timeline` | Unified activity timeline across all related objects |
| Notes | `/api/notes` | Rich text notes attachable to any record |
| Tags | `/api/tags` | Universal tagging with tag assignment tracking |
| Documents | `/api/documents` | Document management with versioning |
| Attachments | `/api/attachments` | File attachments on any parent record (polymorphic) |
| Saved Views | `/api/views` | Saved list view filters and column configurations |
| Search | `/api/search` | Global cross-module search with configurable modules |
| Mass Actions | `/api/mass-actions` | Bulk update, delete, reassign, field set, transfer |
| Surveys | `/api/surveys` | CSAT/NPS/CES surveys with response collection and analytics |
| Scheduler | `/api/scheduler` | Appointment slots, booking, cancellation, availability check |
| Assets | `/api/assets` | Installed product/asset tracking with lifecycle status |
| Partners | `/api/partners` | Partner tiers (Registered/Silver/Gold/Platinum), portal access |
| Subscriptions | `/api/subscriptions` | Recurring subscription management |
| Revenue Recognition | `/api/revenue` | Revenue schedules with period-based entries |
| Teams | `/api/teams` | Account and deal team member assignments with roles |
| Mobile | `/api/mobile` | Device registration, push notification management |
| Currencies | `/api/admin/currencies` | Multi-currency support with exchange rate management |

---

## API Reference

### Authentication Endpoints

```bash
POST /api/auth/register          # Create account
POST /api/auth/login             # Get access + refresh tokens
POST /api/auth/refresh           # Refresh access token
POST /api/auth/logout            # Invalidate tokens
POST /api/auth/forgot-password   # Request password reset
POST /api/auth/reset-password    # Reset with token
GET  /api/auth/me                # Current user profile
```

### Standard CRUD Patterns

Most modules follow a consistent REST pattern:

```
GET    /api/{module}              # List with pagination, search, sort
GET    /api/{module}/:id          # Get single record with relations
POST   /api/{module}              # Create record
PUT    /api/{module}/:id          # Update record
DELETE /api/{module}/:id          # Soft delete (moves to recycle bin)
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number |
| `limit` | integer | `50` | Records per page (max 200) |
| `search` | string | -- | Full-text search across configured fields |
| `sort` | string | `createdAt` | Sort field name |
| `order` | string | `desc` | Sort direction: `asc` or `desc` |

**List Response Format:**

```json
{
  "data": [{ "id": "...", "name": "..." }],
  "meta": {
    "total": 142,
    "page": 1,
    "limit": 50,
    "pages": 3
  }
}
```

**Single Record Response:** Returns the object directly (no wrapper).

**Error Response:**

```json
{ "error": "Human-readable error message" }
```

| HTTP Status | Meaning |
|-------------|---------|
| 400 | Validation error or bad request |
| 401 | Missing or invalid authentication token |
| 403 | Insufficient role permissions |
| 404 | Record not found |
| 409 | Conflict (duplicate email, optimistic locking) |
| 429 | Rate limit exceeded (retry after window) |
| 500 | Internal server error |

### Notable Custom Endpoints

Beyond standard CRUD, many modules expose domain-specific endpoints:

**Deals:**
- `GET /api/deals/stats/pipeline` -- Pipeline summary by stage
- `GET /api/deals/stats/velocity` -- Average days per stage
- `GET /api/deals/stats/aging` -- Stale/at-risk deals
- `GET /api/deals/stats/win-loss` -- Win/loss analysis with rep breakdown
- `GET /api/deals/stats/rollup` -- Full metrics rollup
- `POST /api/deals/:id/clone` -- Clone deal with line items
- `POST /api/deals/:id/submit` -- Submit for approval
- `GET /api/deals/:id/timeline` -- Unified activity timeline
- `GET/PUT /api/deals/:id/competitors` -- Competitor tracking
- `GET/POST /api/deals/:id/contact-roles` -- Contact roles (Decision Maker, Champion, etc.)
- `GET/POST /api/deals/:id/splits` -- Revenue split allocation
- `GET /api/deals/:id/history` -- Stage change history

**Quotes:**
- `POST /api/quotes/:id/accept` -- Accept quote
- `POST /api/quotes/:id/create-invoice` -- Generate invoice from quote
- `GET /api/quotes/:id/pdf` -- PDF export
- `GET/POST /api/quotes/templates` -- Quote template management
- `GET/POST /api/quotes/:id/line-items` -- Line item CRUD with auto-calculated totals

**Surveys:**
- `POST /api/surveys/:id/respond` -- Submit response
- `GET /api/surveys/:id/analytics` -- Response analytics (total, average score)

**Scheduler:**
- `GET /api/scheduler/availability` -- Available slots for user on date
- `POST /api/scheduler/slots/:id/book` -- Book appointment
- `POST /api/scheduler/slots/:id/cancel` -- Cancel booking

**Consent (GDPR):**
- `POST /api/consent/opt-out` -- Self-service opt-out (creates or updates record)

**Admin Dashboard:**
- `GET /api/admin/dashboard/system` -- Platform stats, record counts, security metrics, revenue, health
- `GET /api/admin/dashboard/activity` -- Recent logins, audit entries, flow runs, AI agent runs

**Bulk API:**
- `POST /api/bulk/:module/insert` -- Batch insert
- `POST /api/bulk/:module/update` -- Batch update
- `POST /api/bulk/:module/upsert` -- Batch upsert
- `POST /api/bulk/:module/delete` -- Batch delete

### OpenAPI / Swagger

Generate the OpenAPI 3.0 specification:

```bash
npm run swagger
# Output: src/openapi.json
```

---

## Authentication and Authorization

### JWT Token Flow

Sales Nebula uses a dual-token JWT strategy:

1. **Access Token** (default 15 min TTL) -- sent as `Authorization: Bearer <token>` on every request.
2. **Refresh Token** (default 7 day TTL) -- used to obtain a fresh access token without re-entering credentials.

```bash
# Login
curl -X POST http://localhost:7544/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"thomas@salesnebula.com","password":"password123"}'

# Response: { "token": "eyJ...", "refreshToken": "eyJ...", "user": {...} }

# Authenticated request
curl http://localhost:7544/api/contacts \
  -H "Authorization: Bearer eyJ..."

# Token refresh
curl -X POST http://localhost:7544/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJ..."}'
```

The browser app does not see either token. It signs in with
`X-Session-Mode: cookie`, and the server sets them as httpOnly cookies
(`sn_access`, and `sn_refresh`, which only `/api/auth` receives) that page
scripts cannot read. A readable `sn_csrf` cookie comes with them: every
cookie-authenticated `POST`, `PUT`, `PATCH` or `DELETE` must echo its value in
an `X-CSRF-Token` header, which a forged cross-site request cannot do. Bearer
tokens and API keys, as above, are unaffected. Signing out revokes both
tokens. Only access tokens authenticate API calls; a refresh token cannot.

### Role-Based Access Control (RBAC)

Permissions are defined per module at the role level with three tiers:

| Level | Capabilities |
|-------|-------------|
| `read` | List and view records |
| `edit` | Create and update records |
| `full` | All operations including delete and admin actions |

Each user is assigned one role. The role contains a set of `Permission` records, each specifying a module name and access level. The `requirePermission(module, level)` middleware enforces these at the route level.

### API Key Authentication

For server-to-server integrations, generate API keys via `POST /api/admin/api-keys`. Pass the key as `X-API-Key` header. The key is shown once, in that response: only a SHA-256 of it is stored, so a lost key is replaced, not recovered.

A key acts for the user who created it and stops working if that user is disabled. Give it `permissions: [{ "module": "contacts", "level": "read" }, ...]` to limit it to those modules, never beyond the creator's own access; `"module": "*"` covers every module. A key with an empty `permissions` list carries the creator's full access.

Each key allows `rateLimit` requests per hour (default 1000). Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; past the limit the API answers 429 with `Retry-After`. The count is shared through Redis when `REDIS_URL` is set, and kept per process otherwise.

### SSO and OAuth

SSO providers (SAML 2.0 and OIDC) are configured via `/api/security/sso`. Google and Microsoft sign-in (`/api/oauth`) come pre-wired through environment variables.

### Connected Apps (OAuth 2.0)

Sales Nebula is also an OAuth 2.0 authorization server for third-party apps, using the authorization-code grant with PKCE (S256, required of every app).

1. An administrator registers the app with `POST /api/connected-apps`, giving `name`, `redirectUris` (https, or http on localhost; matched exactly) and `scopes`. The response carries the `clientId` and the `clientSecret`; the secret is shown once, and only a SHA-256 of it is stored.
2. The app sends the user's browser to `/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=read&state=...&code_challenge=...&code_challenge_method=S256`. The user signs in if need be, sees which app is asking and for what, and allows or denies it. Either way the browser goes back to the redirect URI, with `code` and `state`, or with `error=access_denied`.
3. The app's server trades the code within five minutes, once: `POST /api/connected-apps/oauth/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, and its client credentials (HTTP Basic, or `client_id` and `client_secret` in the form body). It gets an access token for one hour and a refresh token for thirty days.
4. It calls the API with `Authorization: Bearer <access_token>`, and renews with `grant_type=refresh_token`, which also replaces the refresh token. `POST /api/connected-apps/oauth/revoke` with `token` ends the grant.

Scopes: `read` allows GET requests, `write` allows any request, and both stay within the user's own permissions, so `write` granted by an administrator includes administration. Whatever its scopes, an app token cannot use `/api/auth` (other than `GET /api/auth/me`), `/api/security` (MFA devices, SSO, sessions), API keys, or `/api/connected-apps`, so an app cannot change anyone's sign-in or authorize itself or another app. Users see and revoke the apps they have authorized under Settings, Security; revoking or disabling an app ends every grant to it.

### Security Features

- Account lockout after configurable failed login attempts (default: 5)
- Bcrypt password hashing (cost factor 10)
- HMAC-SHA256 signed webhooks
- Helmet.js security headers (15 policies)
- Rate limiting per IP (configurable window and max)
- XSS input sanitization on all request bodies
- Login history and event log tracking (Shield)
- Platform encryption policies for sensitive fields
- GDPR consent management with self-service opt-out

---

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure. All variables with defaults are optional.

**Required:**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/sales_nebula`) |
| `JWT_SECRET` | Secret for JWT signing. Use at least 256 bits of randomness. |

**Server:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7544` | API server port |
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `LOG_LEVEL` | `debug` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `FRONTEND_URL` | `http://localhost:7544` | CORS allowed origin(s), comma-separated for multiple |

**Auth:**

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_ACCESS_EXPIRES` | `15m` | Access token TTL |
| `JWT_REFRESH_EXPIRES` | `7d` | Refresh token TTL |
| `MAX_LOGIN_ATTEMPTS` | `5` | Failed attempts before lockout |
| `LOCKOUT_DURATION_MS` | `900000` | Lockout duration in ms (15 min) |

**Rate Limiting:**

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window in ms (15 min) |
| `RATE_LIMIT_MAX` | `200` | Max requests per IP per window |

**Optional Services:**

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection string for caching and job queues |
| `ANTHROPIC_API_KEY` | Anthropic API key (enables the AI endpoints and the Copilot) |
| `ANTHROPIC_MODEL` | Claude model for every AI call (default `claude-opus-5`) |

**File Storage** (S3 or local fallback):

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | -- | AWS region |
| `AWS_ACCESS_KEY_ID` | -- | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | -- | AWS secret key |
| `S3_BUCKET` | -- | S3 bucket for file uploads |
| `S3_BACKUP_BUCKET` | -- | S3 bucket for database backups |
| `UPLOAD_DIR` | `./uploads` | Local fallback upload directory |
| `MAX_FILE_SIZE` | `10485760` | Max upload size in bytes (10 MB) |

**OAuth Providers** (optional, for SSO):

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `MICROSOFT_CLIENT_ID` | Microsoft OAuth client ID |
| `MICROSOFT_CLIENT_SECRET` | Microsoft OAuth client secret |
| `MICROSOFT_TENANT_ID` | Microsoft tenant ID |

---

## Database

### Schema

Prisma is the ORM. The schema file (`prisma/schema.prisma`) defines all 173 models and is the single source of truth. The initial migration (`prisma/migrations/00000000000000_initial/migration.sql`) creates all 173 tables with 253 indexes in a single atomic migration.

### Commands

```bash
npm run db:migrate        # Create migration from schema changes (dev)
npm run db:migrate:prod   # Apply pending migrations (production)
npm run db:push           # Push schema directly, no migration (dev only)
npm run db:studio         # Visual database browser on http://localhost:5555
npm run db:seed           # Seed demo data (admin user, roles, sample records)
npm run db:reset          # Drop all data and re-migrate (destructive)
```

### Key Relationships

The data model follows Salesforce conventions with some enhancements:

- **User** -> Role -> Permission[] (RBAC chain)
- **Account** -> Contact[], Deal[], Case[], Order[], Contract[], Invoice[], Territory[]
- **Contact** -> Activity[], Email[], Case[], Quote[], Document[]
- **Deal** -> LineItem[], ContactRole[], Split[], StageHistory[], Quote[]
- **Campaign** -> Member[], Recipient[], TargetList[], Influence[]
- **Product** -> PricebookEntry[] -> Pricebook, Bundle[] -> BundleItem[]
- **Quote** -> QuoteItem[], QuoteLineItem[] -> Invoice -> InvoiceItem[]
- **Territory** -> TerritoryModel (parent), Territory[] (children), TerritoryAssignment[]
- **FlowDefinition** -> FlowVersion[] -> FlowRun[]
- **CustomObject** -> CustomObjectField[], CustomObjectRecord[]
- **Survey** -> SurveyResponse[]

### Indexes

253 indexes cover primary keys, foreign keys, unique constraints, and composite indexes for common query patterns. Notable composite indexes:

| Index | Table | Purpose |
|-------|-------|---------|
| `(module, recordId)` | AuditLog | Record-level audit history |
| `(dealId, userId, splitType)` | DealSplit | Unique split per user per type |
| `(dealId, contactId)` | DealContactRole | Unique contact role per deal |
| `(parentId, parentModule)` | Attachment, FeedItem | Polymorphic parent lookup |
| `(roleId, module, field)` | FieldLevelSecurity | Unique FLS per role/module/field |
| `(userId, startTime, endTime)` | BookingSlot | Scheduling queries |
| `(activityId, relatedId, relatedModule)` | ActivityRelation | Multi-who dedup |
| `(email)` | PersonAccount, PortalUser | Unique email constraints |

---

## Testing

> **CI is intentionally disabled** — no workflows run on push or pull requests.
> Verify every change locally before pushing. See
> [`.github/CI_DISABLED.md`](.github/CI_DISABLED.md) for the exact steps.

```bash
npm test                # Run every suite
npm run test:watch      # Watch mode for development
npm run test:coverage   # Generate coverage report
npm run test:auth       # Auth suite only
npm run test:reports    # Reports suite only
```

Tests use **Jest** with **supertest** for HTTP assertions, against a PostgreSQL database built with `npx prisma migrate deploy` so the suite runs on exactly the schema production gets. Test suites cover authentication flows (register, login, refresh, lockout), CRUD operations across modules, permission enforcement, business logic (pipeline stats, approval workflows), and error handling.

---

## Deployment

### Docker Compose (Recommended)

```bash
export JWT_SECRET=$(openssl rand -base64 32)
docker compose up -d
```

| Service | Container | Port | Volume | Health Check |
|---------|-----------|------|--------|-------------|
| PostgreSQL 16 | `sn-postgres` | 5432 | `postgres_data` | `pg_isready` every 5s |
| Redis 7 | `sn-redis` | 6379 | `redis_data` | `redis-cli ping` every 5s |
| API Server | `sn-api` | 7544 | `uploads_data` | HTTP GET `/api/health` every 30s |
| Migration | `sn-migrate` | -- | -- | Runs once, exits |

### Manual / VM Deployment

```bash
npm run setup:prod     # Install deps, generate Prisma, run migrations
NODE_ENV=production node src/index.js
```

Use a process manager like PM2 for production:

```bash
pm2 start src/index.js --name sales-nebula -i max
```

### Health Check

```
GET /api/health
```

Returns: database connectivity, uptime, heap memory usage, Node.js version, and timestamp. Used by Docker health checks, load balancers, and the admin dashboard.

### Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` for zero-downtime deploys. On signal: stops accepting connections, drains in-flight requests, disconnects Prisma, and exits with code 0.

### Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name crm.yourcompany.com;

    location /api/ {
        proxy_pass http://127.0.0.1:7544;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        root /var/www/sales-nebula/frontend;
        try_files $uri /index.html;
    }
}
```

---

## Frontend

The React frontend (`frontend/App.jsx`) is a 1,756-line single-file SPA with 28 pages.

### Design System (Bloomberg Terminal Aesthetic)

| Token | Hex | Usage |
|-------|-----|-------|
| Base background | `#060B1A` | Page background, deepest layer |
| Card surface | `#0B1228` | Cards, panels, modals, dropdowns |
| Interactive hover | `#0E1630` | Hover states, active backgrounds |
| Border | `#182550` | Dividers, card borders, separators |
| Primary accent | `#F5A623` | Buttons, active nav, highlights, CTAs |
| Text primary | `#F0EDE5` | Headings, names, critical values |
| Text secondary | `#C8C2B4` | Body text, descriptions |
| Text muted | `#7E8598` | Labels, timestamps, metadata |
| Text disabled | `#4A5168` | Placeholders, inactive elements |
| Success | `#34D399` | Active status, won deals, healthy |
| Danger | `#F87171` | Errors, lost deals, critical alerts |
| Info | `#60A5FA` | Links, informational badges |
| Warning | `#FBBF24` | Pending, attention needed |
| Purple | `#A78BFA` | Role badges, tags |

### Pages (28 Total)

**Core:** Login, Dashboard, Contacts, Leads, Deals, Accounts, Cases, Activities, Campaigns, Products, Quotes, Invoices

**Extended:** Emails, Reports, Workflows, Knowledge, AI Agents, Forecasts, Custom Objects

**System:** Global Search, Settings (7 tabs: Users, Roles, API Keys, Webhooks, Currencies, Recycle Bin, Audit Log), Admin Dashboard

**User Management (Settings > Users):** Add user modal (name, email, password, role, active toggle), inline edit, activate/deactivate toggle, delete with confirmation dialog, role assignment dropdown.

### Shared Components

`Spinner`, `Badge` (8 color variants), `Button`, `Input`, `Select`, `TextArea`, `Modal`, `Toast`, `DataTable` (with pagination), `StatCard`, `EmptyState`, `TopBar` (with global search and notification bell), `Sidebar` (collapsible with all module links).

### Running the Frontend

The frontend expects a Vite dev server or any static file server. Configure `API_BASE` to point at the backend:

```bash
# Development with Vite
cd frontend
npm create vite@latest . -- --template react
# Copy App.jsx into src/
# npm run dev
```

---

## Project Structure

```
sales-nebula-backend/
|-- src/
|   |-- index.js                   # Server entry, port binding, graceful shutdown
|   |-- app.js                     # Express app setup, middleware, all 86 route mounts
|   |-- middleware/
|   |   |-- auth.js                # JWT verify, requirePermission(), API key auth
|   |   |-- audit.js               # req.audit() helper, writes to AuditLog table
|   |   |-- rateLimit.js           # Configurable rate limiter
|   |   |-- sanitize.js            # XSS input sanitization
|   |   |-- validate.js            # Request body validation
|   |-- routes/                    # 86 route modules
|   |   |-- auth.js                # Register, login, refresh, logout, password reset
|   |   |-- users.js               # User CRUD, roles, preferences, online, activity
|   |   |-- contacts.js            # CRUD router + search
|   |   |-- deals.js               # CRUD + pipeline stats, velocity, aging, win/loss
|   |   |-- dealExtras.js          # Contact roles, splits, history
|   |   |-- quotes.js              # CRUD + PDF, accept, create-invoice
|   |   |-- quoteExtras.js         # Templates, line items
|   |   |-- surveys.js             # CRUD + respond, analytics
|   |   |-- scheduler.js           # Slots, booking, cancel, availability
|   |   |-- feed.js                # Posts, comments, likes, pins
|   |   |-- portal.js              # Config + user management
|   |   |-- consent.js             # GDPR consent + opt-out
|   |   |-- monitoring.js          # Login history, event logs, summary
|   |   |-- adminDashboard.js      # System stats, activity feed
|   |   |-- territories.js         # Models, territories, assignment
|   |   |-- ... (72 more modules)
|   |-- utils/
|       |-- crud.js                # CRUD router factory with hooks
|-- prisma/
|   |-- schema.prisma              # 173 models (source of truth)
|   |-- migrations/
|   |   |-- 00000000000000_initial/
|   |       |-- migration.sql      # 173 tables, 253 indexes
|   |-- seed.js                    # Demo data: admin, roles, contacts, deals, etc.
|-- tests/                         # Jest test suites (246 tests)
|-- scripts/
|   |-- generate-swagger.js        # OpenAPI 3.0 spec generator
|   |-- backup.js                  # Database backup to S3 or local
|-- frontend/
|   |-- App.jsx                    # Complete React SPA (1,756 lines, 28 pages)
|-- Dockerfile                     # Multi-stage Node 20 Alpine build
|-- docker-compose.yml             # Postgres + Redis + API + Migration
|-- .env.example                   # All environment variables documented
|-- package.json                   # Dependencies, 18 npm scripts
```

---

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with nodemon (auto-reload on changes) |
| `npm start` | Production start |
| `npm test` | Run all 246 tests |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:coverage` | Tests with coverage report |
| `npm run test:auth` | Auth test suite only |
| `npm run test:reports` | Reports test suite only |
| `npm run db:migrate` | Create and apply new migration (dev) |
| `npm run db:migrate:prod` | Apply pending migrations (production) |
| `npm run db:push` | Push schema directly (dev only, no migration) |
| `npm run db:seed` | Seed demo data |
| `npm run db:studio` | Open Prisma Studio GUI |
| `npm run db:reset` | Reset database and re-migrate (destructive) |
| `npm run setup` | Full dev setup: install, generate, push, seed |
| `npm run setup:prod` | Production setup: install, generate, migrate |
| `npm run swagger` | Generate OpenAPI 3.0 spec to `src/openapi.json` |

---

## Additional Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/API_REFERENCE.md) | Complete endpoint reference for all 86 route modules (1,278 lines) |
| [Architecture Guide](docs/ARCHITECTURE.md) | System design, request lifecycle, module system, data layer, security layers |
| [Product Overview](docs/PRODUCT.md) | Non-technical product capabilities, feature descriptions, deployment options |
| [Changelog](docs/CHANGELOG.md) | Complete feature list and bug fixes for the v1.0.0 release |

---

## License

Proprietary. All rights reserved.

## Tier 1 Feature Modules (v4.3.0)

Three feature areas specced against the SuiteCRM module inventory and
implemented from scratch. No SuiteCRM code was used: SuiteCRM is
AGPL-3.0, and its network clause would force source disclosure to every
SaaS user. The module list was treated as a functional requirements
checklist only, the same approach used for the Odoo-derived ERP scope.

### Calendar (`/api/calendar`, 39 endpoints)

RFC 5545 recurrence engine written from the spec with no third-party
dependency. Supports FREQ, INTERVAL, COUNT, UNTIL, BYDAY with ordinals
(`2FR`, `-1MO`), BYMONTHDAY, BYMONTH, BYSETPOS, and WKST.

- Occurrence-level editing: `scope=occurrence|following|series`.
  Editing one occurrence materializes an exception record; editing
  "following" caps the original series and starts a new one.
- Invitees with accept, decline, and tentative responses.
- Reminders with dismiss, snooze, and due polling.
- Resource booking (rooms, equipment) with conflict detection at 409
  and optional approval workflow.
- Multi-participant availability finder that intersects working hours
  across attendees and returns open slots.
- Token-authenticated public iCal feed at
  `/api/calendar/feed/:token.ics`, subscribable from any calendar
  client. Recurring events publish as masters with their RRULE so the
  client expands them natively.
- `.ics` import and per-event export.

### Projects (`/api/projects`, 36 endpoints)

Critical Path Method engine with forward and backward passes.

- Dependency types FS, SS, FF, SF, each with lag. Cycles are rejected
  at 409 before they are written.
- WBS hierarchy with auto-numbering (1, 1.2, 1.2.1).
- Gantt endpoint returning indented rows, bar geometry, dependency
  links, and critical path flags.
- `/reschedule` persists the CPM result onto the tasks.
- Progress roll-up weighted by estimated hours.
- Project health computed from schedule slip and budget burn.
- Time tracking with timesheets and approval.
- Templates, including save-an-existing-project-as-template and
  instantiate-from-template with parent and dependency rewiring.

### Security Groups (`/api/security-groups`, 24 endpoints)

Row-level access control layered under the existing RBAC.

Access model: admins bypass; owners always see their records; group
members see records assigned to their groups, inheriting from parent
groups; records with no group assignment stay unrestricted.

- `src/middleware/rowSecurity.js` exposes `rowSecurity(module)` which
  attaches `req.accessFilter` (a Prisma where fragment) and
  `req.canAccessRecord()`. Membership is cached for 60 seconds with
  explicit invalidation.
- Auto-assign rules with nine operators and a dry-run preview.
- `/explain/:module/:recordId` returns a human-readable reason for why
  a given user can or cannot see a record.
- Coverage and orphan-group reporting.

### Tests

`tests/tier1.test.js` covers 77 cases across 9 suites. The recurrence,
CPM, WBS, and availability engines are tested directly and pass 40/40
without a database. Route tests activate when supertest and a seeded
`tests/setup.js` are available.

## Tier 1 Remainder and Tier 2 Modules (v4.4.0)

Nine further modules, again specced from the SuiteCRM module inventory
and written from scratch. No SuiteCRM code was used; see the AGPL note
above.

### Document Templates (`/api/pdf-templates`, 16 endpoints)

A merge-field engine (`src/utils/mergeFields.js`) with 20 formatters,
loops, and conditionals:

```
{{contact.firstName}}                simple path
{{deal.amount|currency:USD}}         formatter with argument
{{contact.title|default:Unknown}}    fallback for empty values
{{#each lineItems}}{{@number}}{{/each}}
{{#if discount}}...{{else}}...{{/if}}
```

Templates are validated before save, so an unbalanced block is a 400
rather than a broken document later. A missing field renders as empty
rather than throwing. Starter templates ship for quotes, invoices, and
cases.

### Studio (`/api/studio`, 23 endpoints)

Runtime field builder across 16 modules with 15 field types. Values are
stored in typed columns, not stringified, so numeric and date custom
fields sort and filter correctly.

Guards worth knowing about: reserved names are rejected, a field's type
cannot change once records hold values (409 with the count, rather than
silently stranding data in the wrong column), and a picklist value still
in use is deactivated rather than deleted so historical records stay
readable.

Also covers dependent picklists, per-module layouts, and validation
rules with a dry-run that reports how many existing records would fail.

### SLA and Business Hours (`/api/sla`, 18 endpoints)

`src/utils/businessHours.js` counts only open hours. A ticket raised at
4pm Friday against a four-hour target is due Monday at noon, not Friday
evening. Holidays, custom weekly schedules, and paused windows (waiting
on customer) all subtract correctly.

`addBusinessMinutes` and `businessMinutesBetween` are verified as mutual
inverses, which is the property that keeps a due date and an elapsed
counter from disagreeing.

Case status transitions are recorded to `CaseStatusHistory` so pause
windows can be reconstructed rather than estimated.

### Full-Text Search (`/api/search-index`, 14 endpoints)

Replaces the previous implementation, which ran `contains` (SQL ILIKE
`%term%`) against every table. That cannot use an index and degrades
linearly with row count.

`src/utils/searchIndex.js` builds an inverted index with BM25 ranking
and field weighting, so a title hit outranks the same word buried in a
description. The tokenizer folds accents and preserves emails, URLs,
phone numbers, and ticket identifiers, because users search for those
literally.

Query syntax: `"exact phrase"`, `-excluded`, `+required`,
`status:Open`, `prefix*`. Zero-result queries return spelling
suggestions via bounded edit distance. Click-through is logged so
ranking quality is measurable rather than assumed.

### Inbound Email (`/api/inbound-email`, 17 endpoints)

IMAP and POP3 account configuration with passwords encrypted at rest
(AES-256-GCM, fresh IV per call). The API never returns a stored
password, only a `passwordSet` flag.

Message transport lives outside the API: a worker fetches and posts
messages, and this module owns deduplication, routing, and threading.
Replies are matched to existing cases by ticket tag, then by
`In-Reply-To`, then by normalized subject plus sender. Auto-replies and
bounces are detected and never open a ticket.

### Favorites and Recently Viewed (`/api/favorites`, 13 endpoints)

Star toggling, pinning, reordering, and a bulk membership check so a
list view renders its stars in one request rather than one per row.
Recently-viewed trims its own tail at 200 rows per user.

### Territory Maps (`/api/maps`, 22 endpoints)

Geocode cache, polygon and radius territories, marker layers, proximity
search, and route ordering. Nearby search prefilters with a bounding box
so the database does the coarse work before the haversine pass runs in
memory. Territory assignment is recomputed in one call, and GeoJSON
imports and exports round-trip.

### Prospects (`/api/prospects`, 22 endpoints)

Pre-lead records with completeness scoring, deduplication by email,
merge with list-membership carry-over, static and dynamic target lists,
and a suppression list that supports whole-domain entries (`@example.com`).
List population honours suppression automatically.

### Bugs and Releases (`/api/bugs`, 15 endpoints)

Issue tracking with sequential numbering, field-level history, watchers,
reopen counting, and release notes generated from the fixed-bug list. A
triage endpoint weights open bugs by severity, priority, age, reopen
count, and whether anyone owns them.

### Tests

`tests/tier2.test.js` adds 111 cases across 14 suites. The merge-field,
business-hours, and search engines pass 51/51 without a database.
Combined with Tier 1 that is 188 cases and 91 engine assertions.

## Public Site and Access Control (v4.5.0)

### The tenancy constraint

This schema has **no tenancy**. Every record lives in one shared dataset,
and no model carries an organization or workspace key. That is a
deliberate design for a single-company deployment, but it means an open
public registration would drop strangers straight into live customer
data.

So `POST /api/auth/register` is now **disabled by default** and returns
403 unless `ALLOW_OPEN_REGISTRATION=true` is set explicitly. Turning it
on is a deployment decision, not an accident.

Multi-tenancy would touch all 286 models and is not attempted here.
Until it exists, treat every account as having full visibility.

### Signup and invites (`/api/signup`, 14 endpoints)

Public signup captures a **request**, never a user:

1. A visitor submits the form. A `SignupRequest` is created and a
   verification token is emailed. No account exists yet.
2. The visitor confirms the address. The request becomes `Verified`.
3. An administrator approves it, which issues a `UserInvite`.
4. The invitee sets a password against the invite token. Only this
   step creates a `User`.

Tokens are stored as SHA-256 hashes, never in plaintext, and are
single-use. Verification links last 48 hours, invites 7 days. The
endpoint returns an identical response for known and unknown addresses,
so it cannot be used to enumerate accounts. Disposable email domains are
rejected. Public endpoints carry their own tighter rate limits.

In non-production the API returns `devVerifyUrl` and `devInviteUrl` in
the response body, so the whole flow is testable without an SMTP server.

### Public site

The app and the marketing site are now separate surfaces:

| Path | Renders |
| --- | --- |
| `/` | Landing page |
| `/verify?token=` | Email confirmation |
| `/accept-invite?token=` | Set a password, creates the account |
| `/login` | Sign in |
| `/app` | The product, session required |

Routing is a small path matcher in `main.jsx` rather than a router
dependency. The API serves the built SPA and falls back to `index.html`
for any non-API GET, so an emailed verification link resolves instead of
returning a JSON 404.

The landing page quotes real figures. `frontend/src/moduleManifest.js` is
generated from the live route table by `scripts/module-manifest.js`, so
the module grid cannot drift from what actually ships. Re-run it after
adding routes.

### Frontend-only demo access

Staff credentials are never exposed on the sign-in screen. The “Use demo
access” button fills a dedicated browser-only login. Submitting it creates a
local read-only demo session backed by sample data in `frontend/src/demo.js`;
it does not call the authentication API or require a running database.

### Deployment fixes

Two gaps meant the public site would not have existed in production:

- The Dockerfile copied `frontend/` as source and never ran a build, so
  the image shipped uncompiled React. It now builds in the builder stage
  and ships only `frontend/dist`.
- The API served no static files and had no history fallback. It now
  serves the SPA with immutable caching on fingerprinted assets and
  `no-cache` on the shell.

### Eleven route files did not load

Unrelated to this work but found by it: `leads`, `campaigns`, `products`,
`ai`, `adminDashboard`, `advancedCpq`, `bulkApi`, `connectedApps`,
`dataExport`, `flowBuilder`, and `security` all threw `ReferenceError` at
module load, because routes appended after a `createCrudRouter()` export
referenced `authenticate`, `auditMiddleware`, or `router` without
importing or binding them. `leads.js` assigned `module.exports` directly,
so `router` never existed.

`createApp()` therefore threw and **the server did not start at all**.
`node -c` had not caught it because these are runtime reference errors,
not syntax errors. All eleven are fixed and there is now a mount check in
the audit that loads and mounts every router.
