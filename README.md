# Sales Nebula CRM

A self-hosted CRM for sales and service teams: accounts, contacts, leads, deals, quotes, invoices, cases and the automation around them. Built with Node.js, Express, Prisma, and PostgreSQL on the backend, with a React frontend in a Bloomberg Terminal-inspired dark aesthetic.

It is not a Salesforce replacement feature for feature. Some modules store configuration that nothing acts on yet, and their actions answer **501** instead of pretending; [Feature status](docs/FEATURE_STATUS.md) lists what works, what is limited, and what is unavailable.


## Running it

Two paths, both of which end with the public site at `/` and the product at `/app`.

**Docker:**

```bash
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET, INITIAL_ADMIN_EMAIL,
# INITIAL_ADMIN_PASSWORD and your public FRONTEND_URL. Configure SMTP.
docker compose up --build -d
```

The image builds the frontend and waits for migrations and first-administrator
creation before starting the API. Production creates no demo users or records.
See [Sales pilot setup](docs/SALES_PILOT.md) for credentials, workflows and backup
verification. In production the app refuses to start without a real `JWT_SECRET`
(at least 32 characters, and not a placeholder such as the one in `.env.example`),
and `docker compose up` stops with a message if it is not set.

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

Sign in at `/login` with the administrator configured during production setup.
In a local development install, the seeded administrator is `thomas@salesnebula.com`
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

## Sales pilot workflows

The app now exposes lead conversion (contact, optional account and deal), email
composition and sending from contacts/deals or saved drafts, quote product-line
editing and totals, document preview/print, acceptance recording, and invoice
creation from a quote. Related records can be opened from detail screens.
Actions respect role permissions and the browser demo remains read-only.

The [sales workspace](docs/SALES_WORKSPACE.md) adds My Day follow-ups, a pipeline
board and saved views, private Outlook conversations, report building and sales
performance, sequence editing, and creating records from related lists. See the
guide for Outlook consent, SMTP delivery, and deployment requirements.

`npm run verify` runs the local release gate, including browser tests with a real
API, PostgreSQL and a local SMTP server. GitHub Actions remains disabled. See
[Sales pilot setup and verification](docs/SALES_PILOT.md).

## At a Glance

Counted from the code in October 2026:

| Metric | Count |
|--------|-------|
| Database models | 286 |
| Route files | 100 (17 of them built on the CRUD router factory) |
| Route handlers | about 1,280, counting the CRUD factory's |
| Frontend pages | 55 |
| Jest test files | 51 |
| Browser (Playwright) specs | 5 |

A count says how much code there is, not how much of it works: see [Feature status](docs/FEATURE_STATUS.md).

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
# Set POSTGRES_PASSWORD, JWT_SECRET, INITIAL_ADMIN_EMAIL and
# INITIAL_ADMIN_PASSWORD in .env before the first startup.

# Start all services (Postgres, Redis, API)
docker compose up -d

# The migrate service runs automatically on first boot
# API available at http://localhost:7544
```

Docker Compose provisions PostgreSQL 16 with persistent volumes, Redis 7 for caching, the API server with health checks, and a one-shot migration container that applies the schema and creates the first administrator without demo records.

---

## Architecture

```
Client (React SPA)
    |
    v
Express API Server (Node.js)
    |-- JWT Authentication
    |-- Role-Based Access Control (RBAC)
    |-- Rate Limiting (per IP, in memory)
    |-- XSS Filtering (JSON and form bodies, query strings)
    |-- Helmet Security Headers
    |-- Gzip Compression
    |-- Pino Structured Logging
    |-- Audit Logging (record writes, and actions routes log)
    |
    v
Prisma ORM (type-safe, generated client)
    |
    v
PostgreSQL 16            Redis 7, optional
(primary data store)     (job queues, sign-out list, API key counters)
```

### Key Design Decisions

**Prisma ORM** handles all database operations with type-safe queries, migrations, and a generated client. The schema (`prisma/schema.prisma`) is the single source of truth for all 286 models.

**CRUD Router Factory** (`src/utils/crud.js`) generates standardized REST endpoints for any module in a single function call. Each generated router includes paginated listing, full-text search, field selection, sorting, audit logging, soft deletes, and permission checks. Modules requiring custom logic extend the base router via hooks: `beforeCreate`, `afterUpdate`, `validate`, `searchFilter`, and `customRoutes`.

**One Write Path** (`src/services/recordWrites.js`) is how a record of a module is created, changed or deleted, wherever the change comes from: the CRUD routers, import, the bulk API, mass actions, mobile sync, lead and prospect conversion, web-to-lead, web-to-case, email-to-case, the portal, inbound mail, the jobs, and each module's own actions (escalate, activate, renew, merge, clone). It runs the module's hooks (numbering, a case's closedAt and status history, a deal's currency and stage history), then validation rules (and, on create, duplicate and assignment rules) before the write, and audit, security groups, real-time events, workflows and webhooks after it. Inside a transaction the automation waits until it commits (`runAfter`). A write a rule refuses throws a `RecordWriteError`, which the API answers with the rule's message; a batch reports it against the row and carries on with the rest. `tests/writePaths.test.js` fails when a file writes these records directly, except for the few bookkeeping writes it lists with a reason.

**Middleware Stack** is applied in this order: Helmet (security headers, with a content security policy in production), compression, a request ID, CORS, body parsing, an HTTP parameter pollution guard, XSS filtering of bodies and query strings, logging, metrics, then rate limiting on `/api`. After that, route-level middleware handles JWT authentication, permission checks, and audit logging.

**Soft Deletes** mark a record deleted and put it in the Recycle Bin, where it can be restored for 30 days. After that the bin entry expires; the row stays in its table until an administrator purges deleted records.

---

## Modules

The tables below list the API modules, grouped the way Salesforce groups its clouds for familiarity. A module being listed does not mean it matches the Salesforce feature of the same name: several store configuration that nothing acts on yet. [Feature status](docs/FEATURE_STATUS.md) says which.

### Sales Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Leads | `/api/leads` | Lead capture, web-to-lead, assignment rules; rule-based scoring (automatic for web-to-lead, on request otherwise) |
| Contacts | `/api/contacts` | Contact management with account relationships |
| Accounts | `/api/accounts` | B2B account hierarchy, team assignments |
| Person Accounts | `/api/person-accounts` | B2C individual accounts |
| Deals (Opportunities) | `/api/deals` | Full pipeline with stages, probability, line items, forecasting, clone, competitors, win/loss analysis, aging, velocity |
| Deal Extras | `/api/deals` | Contact roles, revenue splits, stage history |
| Products | `/api/products` | Product catalog with SKUs, bundles, discount schedules |
| Quotes | `/api/quotes` | Quotes with line items and totals, accept, invoice from a quote; prints as HTML (no PDF file) |
| Quote Extras | `/api/quotes` | Discounts, clone, convert to order, versions, compare |
| Orders | `/api/orders` | Order processing and fulfillment tracking |
| Contracts | `/api/contracts` | Contract lifecycle management |
| Invoices | `/api/invoices` | Invoice generation from quotes with line items |
| Forecasts | `/api/forecasts` | Forecasts built from the owner's open deals, refreshed every 4 hours; quotas entered by hand |
| Territories | `/api/territories` | Hierarchical territories and manual account mapping (assignment rules are stored only) |
| Sales Path | `/api/sales-path` | Guided selling stages with coaching content (API only, no screen) |
| CPQ | `/api/cpq` | Configure-Price-Quote: bundles, pricebooks, price calculation |
| Advanced CPQ | `/api/cpq/advanced` | Guided selling, discount tiers; product rules checked by `validate-quote` only; price rules stored only |

### Service Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Cases | `/api/cases` | Case management with comments, escalation, priority routing |
| Email-to-Case | `/api/public/email-to-case` | Inbound email auto-creates cases (webhook; requires `EMAIL_TO_CASE_SECRET`) |
| Web-to-Case | `/api/public/web-to-case` | Web form submission creates cases (public, no auth) |
| Knowledge | `/api/knowledge` | Articles with categories, publishing and search; a new version copies the article |
| Entitlements | `/api/entitlements` | Service entitlements with case counts (milestones stored only) |
| SLA Policies | (via configuration) | Service level agreements with response/resolution targets |
| Omnichannel | `/api/omnichannel` | Agent presence and "Least Active" routing (capacity and skills not checked) |
| Field Service | `/api/field-service` | Work orders: dispatch, schedule (dates and assignee), complete, cancel |
| Macros | `/api/macros` | Run on demand: update a field, add a case comment |

### Marketing Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Campaigns | `/api/campaigns` | Campaign planning, members, recipients, target lists and ROI tracking; bulk delivery unavailable |
| Campaign Influence | `/api/campaign-influence` | Attribution models (linear, first touch, last touch) over touches entered by hand |
| Emails | `/api/emails` | Templates, drafts, and sending over SMTP or a Microsoft mailbox |
| Email Sequences | `/api/sequences` | Multi-step sequences, sent every 10 minutes when SMTP is set up |

### Experience Cloud

| Module | Endpoint | Description |
|--------|----------|-------------|
| Portal | `/api/portal` | One portal configuration and its branding (no self-registration: an administrator creates portal logins) |
| Portal Users | `/api/portal/:id/users` | User provisioning with bcrypt password hashing |
| Chatter | `/api/chatter` | Posts, comments, likes, mentions (legacy) |
| Feed | `/api/feed` | Record feeds: posts, likes, comments |

### Platform

| Module | Endpoint | Description |
|--------|----------|-------------|
| Custom Objects | `/api/custom-objects` | Objects with typed fields and JSON records, through the API (records are not checked against the fields) |
| Custom Fields | `/api/studio` | Field definitions only; storing values answers 501 |
| Validation Rules | (via configuration) | Formula-based data validation on any module |
| Record Types | `/api/configuration` | Stored only |
| Page Layouts | `/api/configuration` | Stored only |
| Formula Fields | `/api/formulas` | Formulas evaluated on request (not on records; no cross-object references) |
| Flows | `/api/flows` | Flow definitions and versions; running a flow answers 501 |
| Workflows | `/api/workflows` | Rule-based automation: field updates, email alerts, tasks |
| Approvals | `/api/approvals` | Multi-step approval processes with configurable approvers |
| Platform Events | `/api/events` | Published events stored and sent to webhooks registered for `platform.<channel>` |
| Environments | `/api/environments` | Metadata export; creating, deploying and importing answer 501 |
| Custom Code | `/api/custom-code` | Stored scripts with a syntax check; custom code never runs (501) |
| Custom Components | `/api/custom-components` | Stored only; nothing renders them |

### Analytics and AI

| Module | Endpoint | Description |
|--------|----------|-------------|
| Reports | `/api/reports` | Saved reports run with real rows and totals, folders, CSV/JSON export; scheduling answers 501 |
| Analytics | `/api/analytics` | Overview, ad-hoc query, funnel and cohort figures (datasets only count rows; dashboards are stored only) |
| Dashboard | `/api/dashboard` | Executive KPI dashboard with pipeline, activities, forecasts |
| AI Agents | `/api/ai-agents` | Agent configuration; running, activating and training answer 501 |
| Copilot | `/api/copilot` | Answers with Claude when `ANTHROPIC_API_KEY` is set, from fixed rules otherwise |
| Conversation Intelligence | `/api/conversation-intelligence` | Keyword analysis of a transcript you supply (no upload or transcription); the dialer answers 501 |
| Lead Scoring | (via configuration) | Scoring rules, applied to web-to-lead leads and on request |

### Data and Integration

| Module | Endpoint | Description |
|--------|----------|-------------|
| Import | `/api/import` | CSV import with validation and per-row errors (no Excel) |
| Export | `/api/export` + `/api/data-export` | Data export in CSV or JSON (no Excel) |
| Bulk API | `/api/bulk` | High-volume batch insert/update/delete/upsert operations |
| Webhooks | `/api/webhooks` | Outbound webhooks with HMAC-SHA256 signing, exponential retry, delivery logs |
| Integrations | `/api/integrations` | Configuration and credential storage only; generic sync and connection tests unavailable |
| Connected Apps | `/api/connected-apps` | OAuth2 client application management |
| OAuth Sign-In | `/api/oauth` | Provider-specific Google and Microsoft sign-in APIs, when configured |
| Marketplace | `/api/marketplace` | App listings and reviews; installing answers 501 |
| CDP | `/api/cdp` | Live contact profiles and segment evaluation; ingesting data answers 501 |

### Security and Compliance

| Module | Endpoint | Description |
|--------|----------|-------------|
| Users | `/api/users` | Users, role assignment, activate/deactivate, preferences; "online" means active in the last 15 minutes |
| Roles and Permissions | `/api/users/roles` | Role CRUD with per-module permission levels (read/edit/full) |
| Sharing Rules | `/api/sharing` | Record sharing rules and org-wide defaults |
| Field-Level Security | `/api/configuration` | Not enforced; saving answers 501 |
| Org-Wide Defaults | (via configuration) | Default record visibility (Private/Public Read/Public Read-Write) |
| SSO | `/api/security` | SAML 2.0 and OIDC configuration storage; sign-in unavailable |
| MFA | `/api/security` | Authenticator-app (TOTP) multi-factor authentication |
| Encryption (Shield) | `/api/security` | Not available; saving a policy answers 501 |
| Consent | `/api/consent` | Consent records with opt-in and opt-out per contact, for signed-in users (there is no public opt-out link) |
| Monitoring | `/api/monitoring` | Login history and 24-hour sign-in figures (nothing writes event logs yet) |
| Admin Dashboard | `/api/admin/dashboard` | System health, record counts, security metrics, revenue pipeline, recent activity |
| Audit Log | `/api/admin/audit-log` | Record writes and audited actions (action, module, record, user, time), kept 90 days |
| Recycle Bin | `/api/recycle-bin` | Restore deleted records within 30 days |
| Duplicate Management | `/api/duplicates` | Duplicate rules checked when a record is created; merge for contacts, leads and accounts |

### Other Modules

| Module | Endpoint | Description |
|--------|----------|-------------|
| Activities | `/api/activities` | Tasks, calls, meetings, events with multi-who support |
| Timeline | `/api/timeline` | A record's own activities, emails, notes, cases, changes and posts |
| Notes | `/api/notes` | Rich text notes attachable to any record |
| Tags | `/api/tags` | Universal tagging with tag assignment tracking |
| Documents | `/api/documents` | Document management with versioning |
| Attachments | `/api/attachments` | File attachments on any parent record (polymorphic) |
| Saved Views | `/api/views` | Saved list view filters and column configurations |
| Search | `/api/search` | Global cross-module search with configurable modules |
| Mass Actions | `/api/mass-actions` | Bulk update, delete, reassign, field set, transfer |
| Surveys | `/api/surveys` | CSAT/NPS/CES surveys with response collection and analytics |
| Scheduler | `/api/scheduler` | Booking with an overlap check, cancellation, open slots in a fixed 9-to-5 day |
| Assets | `/api/assets` | Installed product/asset tracking with lifecycle status |
| Partners | `/api/partners` | Partner tiers (Registered/Silver/Gold/Platinum) |
| Subscriptions | `/api/subscriptions` | Recurring subscription management |
| Revenue Recognition | `/api/revenue` | Schedules split evenly by month; periods recognized by hand |
| Teams | `/api/teams` | Account and deal team member assignments with roles |
| Mobile | `/api/mobile` | Device registration and sync for a mobile client; push answers 501 |
| Currencies | `/api/admin/currencies` | One exchange rate per currency; deal totals converted in dashboards and forecasts |

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
| `search` | string | -- | Search across the module's configured fields |
| `sortBy` | string | the module's default | Sort field name |
| `sortDir` | string | `desc` | Sort direction: `asc` or `desc` |
| any column | string | -- | Filter on the record's own column, e.g. `?accountId=...&status=Open`; `<column>From` and `<column>To` give a range |

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
| 501 | The feature is not available in this install. The body's `code` names it (for example `FLOWS_UNAVAILABLE`) and nothing was changed; see [Feature status](docs/FEATURE_STATUS.md) |

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
- `GET /api/deals/:id/stage-history` -- Stage change history, with days in each stage

**Quotes:**
- `POST /api/quotes/:id/accept` -- Accept quote
- `POST /api/quotes/:id/create-invoice` -- Generate invoice from quote
- `GET /api/quotes/:id/pdf` -- The quote as a printable HTML page (print it to PDF from the browser; no PDF file is generated)
- Line items come back as `items` on `GET /api/quotes/:id`, and are replaced by sending `items` to `PUT /api/quotes/:id`, which recalculates the totals

**Surveys:**
- `POST /api/surveys/:id/respond` -- Submit response
- `GET /api/surveys/:id/results` -- Results: totals, per-question figures, NPS

**Scheduler:**
- `GET /api/scheduler/availability` -- Available slots for user on date
- `POST /api/scheduler` -- Book an appointment (409 if it overlaps the host's others)
- `POST /api/scheduler/:id/cancel` -- Cancel an appointment

**Consent (GDPR):**
- `POST /api/consent/opt-out` -- Self-service opt-out (creates or updates record)

**Admin Dashboard:**
- `GET /api/admin/dashboard/system` -- Platform stats, record counts, security metrics, revenue, health
- `GET /api/admin/dashboard/activity` -- Recent logins, audit entries, flow runs, AI agent runs

**Bulk API:**
- `POST /api/bulk/insert` -- Batch insert (`{ module, records }`)
- `POST /api/bulk/update` -- Batch update (`{ module, records }`)
- `POST /api/bulk/upsert` -- Batch upsert (`{ module, records, matchField }`)
- `POST /api/bulk/delete` -- Batch delete (`{ module, ids }`)

Each record goes through the same rules, workflows and audit as a single save.

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

Nobody grants more than they hold. Creating or inviting a user, approving a signup, changing someone's role, or creating or editing a role is refused when the role involved has a higher level on any module than the person making the change, and only an administrator can grant or manage the Admin role or change an administrator's account. Invites and signup approvals take `users: full`, as creating a user does.

Each user is assigned one role. The role contains a set of `Permission` records, each specifying a module name and access level. The `requirePermission(module, level)` middleware enforces these at the route level.

`admin: read` opens the setup screens read only (Studio, Security Groups and the like); the default Sales Rep role has it. On its own it does not reach other people's sign-ins or organisation-wide figures: login history, active sessions, failed sign-ins and the Admin dashboard also take `users: read`, and the log of privacy requests takes `admin: edit`, as logging one does. The sidebar leaves out the Admin and Privacy entries for roles that cannot open them.

### API Key Authentication

For server-to-server integrations, generate API keys via `POST /api/admin/api-keys`. Pass the key as `X-API-Key` header. The key is shown once, in that response: only a SHA-256 of it is stored, so a lost key is replaced, not recovered.

A key acts for the user who created it and stops working if that user is disabled. Give it `permissions: [{ "module": "contacts", "level": "read" }, ...]` to limit it to those modules, never beyond the creator's own access; `"module": "*"` covers every module. A key with an empty `permissions` list carries the creator's full access.

Each key allows `rateLimit` requests per hour (default 1000). Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; past the limit the API answers 429 with `Retry-After`. The count is shared through Redis when `REDIS_URL` is set, and kept per process otherwise.

### SSO and OAuth

`/api/security/sso` stores SAML 2.0 and OIDC configuration, but does not enable sign-in. `POST /api/security/sso/login` returns **501 Not Implemented**; use password sign-in in the browser. SMS and email MFA are also unavailable; use an authenticator app (TOTP).

The separate Google and Microsoft sign-in APIs (`/api/oauth`) are implemented and require `OAUTH_LOGIN_ENABLED=true` plus provider credentials. Microsoft also requires your directory's GUID in `MICROSOFT_TENANT_ID`. These APIs sign in existing, active accounts only. The current browser login does not include provider buttons or an OAuth callback flow; enabling environment variables alone does not add them.

### Feature availability for a sales pilot

Campaigns support planning, recipient lists and response tracking. Bulk campaign delivery is unavailable: `POST /api/campaigns/:id/send` returns **501** without changing campaign or recipient delivery state. Individual sales emails remain available through the email workflow when SMTP is configured.

Generic integration records under `/api/integrations` store configuration only. Their sync and connection-test actions return **501**; saving a schedule does not start a sync worker. Stored status, dates and log summaries do not establish a live connection. This limitation does not apply to the separate Microsoft mailbox APIs under `/api/inbound-email`, outbound webhooks or Connected Apps.

These are two of several features that answer 501 or store settings nothing acts on; [Feature status](docs/FEATURE_STATUS.md) lists them all.

### Connected Apps (OAuth 2.0)

Sales Nebula is also an OAuth 2.0 authorization server for third-party apps, using the authorization-code grant with PKCE (S256, required of every app).

1. An administrator registers the app with `POST /api/connected-apps`, giving `name`, `redirectUris` (https, or http on localhost; matched exactly) and `scopes`. The response carries the `clientId` and the `clientSecret`; the secret is shown once, and only a SHA-256 of it is stored.
2. The app sends the user's browser to `/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=read&state=...&code_challenge=...&code_challenge_method=S256`. The user signs in if need be, sees which app is asking and for what, and allows or denies it. Either way the browser goes back to the redirect URI, with `code` and `state`, or with `error=access_denied`.
3. The app's server trades the code within five minutes, once: `POST /api/connected-apps/oauth/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, and its client credentials (HTTP Basic, or `client_id` and `client_secret` in the form body). It gets an access token for one hour and a refresh token for thirty days.
4. It calls the API with `Authorization: Bearer <access_token>`, and renews with `grant_type=refresh_token`, which also replaces the refresh token. `POST /api/connected-apps/oauth/revoke` with `token` ends the grant.

Scopes: `read` allows GET requests, `write` allows any request, and both stay within the user's own permissions, so `write` granted by an administrator includes administration. Whatever its scopes, an app token cannot use `/api/auth` (other than `GET /api/auth/me`), `/api/security` (MFA devices, SSO, sessions), API keys, or `/api/connected-apps`, so an app cannot change anyone's sign-in or authorize itself or another app. Users see and revoke the apps they have authorized under Settings, Security; revoking or disabling an app ends every grant to it.

### Real-Time Updates (WebSocket)

Socket.io runs on the API server. A client connects with a session access token (`auth: { token }`, or the `sn_access` cookie); connected-app tokens and API keys are not accepted. Every socket joins its user's room for notifications and approval requests. `join:record` (`{ module, recordId }`) needs a record the user can see. `join:module` (a module name) needs read permission on the module and no records in it hidden from the user, since it hears about every record; anyone else follows records one by one. Both answer an optional ack with `{ ok, reason }`. Record events (`record:created`, `record:updated`, `record:deleted`, `deal:stageChanged`) carry the module and record id only; fetch the record through the API. A socket closes, after a `session:expired` event, when its access token expires; reconnect with a fresh token and rejoin.

### Security Features

- Account lockout after configurable failed login attempts (default: 5)
- Bcrypt password hashing (cost factor 10)
- HMAC-SHA256 signed webhooks
- Helmet.js security headers
- Rate limiting per IP (`RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX` tune the standard tier)
- XSS filtering of JSON and form bodies and query strings
- Login history
- IMAP/POP3 mailbox passwords encrypted at rest (AES-256-GCM)
- Consent records per contact

---

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure. All variables with defaults are optional.

**Required:**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/sales_nebula`) |
| `JWT_SECRET` | Secret for JWT signing: at least 32 characters (`openssl rand -base64 48`), and never a placeholder such as the one in `.env.example`. With `NODE_ENV=production` the app refuses to start on a missing, placeholder or short key, since anyone who knows the key can sign an administrator's session. |

**Server:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7544` | API server port |
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `LOG_LEVEL` | `debug` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `FRONTEND_URL` | `http://localhost:7544` | CORS allowed origin(s), comma-separated for multiple. The app is also allowed to talk to itself: a page served from any address of this server may call it, listed or not. Links in emails point at the first one. |

**Mail** (without `SMTP_HOST` nothing is emailed: password reset links, invitations and sequence steps are only written to the log, and the app says so at start-up in production):

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | -- | SMTP server. Setting it turns email on |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (usually port 465) |
| `SMTP_USER` / `SMTP_PASS` | -- | SMTP credentials, if the server needs them |
| `MAIL_FROM` | `SMTP_USER` | The From address, e.g. `Sales Nebula <crm@example.com>` |
| `MAIL_SECRET` | `JWT_SECRET` | Key that encrypts stored mailbox credentials; the same length rule as `JWT_SECRET` applies in production |

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
| `RATE_LIMIT_MAX` | `1000` | Max requests per IP per window |

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

Prisma is the ORM. The schema file (`prisma/schema.prisma`) defines all 286 models and is the single source of truth. `prisma/migrations` holds the migrations that build it, from the initial one onward; production applies them with `npm run db:migrate:prod`.

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

Indexes cover primary keys, foreign keys, unique constraints, and composite indexes for common query patterns. Notable composite indexes:

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

The React frontend lives in `frontend/src`. Most of the 55 pages are in `App.jsx` (about 6,500 lines); the landing page, shared controls, related lists and a few others have files of their own. The API serves the built app (`npm run build`) at `/app`.

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

### Pages (55)

The sidebar groups them:

- **CRM:** Dashboard, Contacts, Leads, Deals, Accounts, Activities, Calendar
- **Communication:** Emails, Campaigns, Chatter, Notes
- **Revenue:** Products, Quotes, Invoices, Contracts, Orders, Subscriptions, Forecasts
- **Service:** Cases, Knowledge, Work Orders, Entitlements
- **Automation & AI:** Workflows, Approvals, AI Agents, AI Copilot, Flow Builder, Sequences
- **Operations:** Projects, Prospects, SLA Board, Bugs, Territory Map
- **Platform:** Custom Objects, Marketplace, Partners, Territories
- **Content:** Documents, Surveys, Templates, Assets
- **Tools:** Reports, Analytics, Search, Import, Tags, Webhooks, Studio, Security Groups
- **Administration:** Users, Access requests, Privacy, Settings (Profile, Appearance, Security, Notifications), Admin

The Recycle Bin has no sidebar entry; it opens at `/app/recycleBin`. Each sidebar entry shows only to roles that may open it. Accounts, contacts, deals and quotes have a **Related** tab listing the records linked to them. Flow Builder, AI Agents, Marketplace and Studio's custom fields say on the page what does not run; see [Feature status](docs/FEATURE_STATUS.md).

**Users:** invite, edit, deactivate and reactivate people, send a password reset, and resend or revoke invites, as described under [Signup and invites](#signup-and-invites-apisignup-14-endpoints). Accounts are deactivated, not deleted.

### Shared Components

`Spinner`, `Badge` (8 color variants), `Button`, `Input`, `Select`, `TextArea`, `Modal`, `Toast`, `DataTable` (with pagination), `StatCard`, `EmptyState`, `TopBar` (with global search and notification bell), `Sidebar` (collapsible with all module links).

### Running the Frontend

The API serves the built app, so `npm run build` and then `npm start` give you the site at `/` and the product at `/app`, on port 7544. Rebuild after changing anything under `frontend/src`.

---

## Project Structure

```
sales-nebula-backend/
|-- src/
|   |-- index.js                   # Server entry, port binding, graceful shutdown
|   |-- app.js                     # Express app setup, middleware, every route mount
|   |-- middleware/
|   |   |-- auth.js                # JWT verify, requirePermission(), API key auth
|   |   |-- audit.js               # req.audit() helper, writes to AuditLog table
|   |   |-- rateLimit.js           # Configurable rate limiter
|   |   |-- sanitize.js            # XSS input sanitization
|   |   |-- validate.js            # Request body validation
|   |-- routes/                    # 100 route files
|   |   |-- auth.js                # Register, login, refresh, logout, password reset
|   |   |-- users.js               # User CRUD, roles, preferences, online, activity
|   |   |-- contacts.js            # CRUD router + search
|   |   |-- deals.js               # CRUD + pipeline stats, velocity, aging, win/loss
|   |   |-- dealExtras.js          # Contact roles, splits, history
|   |   |-- quotes.js              # CRUD + printable quote, accept, create-invoice
|   |   |-- quoteExtras.js         # Templates, line items
|   |   |-- surveys.js             # CRUD + respond, analytics
|   |   |-- scheduler.js           # Slots, booking, cancel, availability
|   |   |-- feed.js                # Posts, comments, likes, pins
|   |   |-- portal.js              # Config + user management
|   |   |-- consent.js             # GDPR consent + opt-out
|   |   |-- monitoring.js          # Login history, event logs, summary
|   |   |-- adminDashboard.js      # System stats, activity feed
|   |   |-- territories.js         # Models, territories, assignment
|   |   |-- ... (85 more route files)
|   |-- services/
|   |   |-- recordWrites.js        # The one write path: rules, hooks, audit, workflows, webhooks
|   |-- utils/
|       |-- crud.js                # CRUD router factory with hooks
|       |-- unavailable.js         # The 501 answer for features this install lacks
|-- prisma/
|   |-- schema.prisma              # 286 models (source of truth)
|   |-- migrations/                # SQL migrations, applied in order
|   |-- seed.js                    # Demo data: admin, roles, contacts, deals, etc.
|-- tests/                         # Jest suites (51 files)
|-- e2e/                           # Playwright browser tests, with a test server
|-- scripts/
|   |-- generate-swagger.js        # OpenAPI 3.0 spec generator
|   |-- backup.js                  # Database backup to S3 or local
|-- frontend/src/
|   |-- App.jsx                    # Most of the app's 55 pages (about 6,500 lines)
|   |-- Landing.jsx                # The public site
|-- Dockerfile                     # Multi-stage Node 20 Alpine build
|-- docker-compose.yml             # Postgres + Redis + API + Migration
|-- .env.example                   # All environment variables documented
|-- package.json                   # Dependencies and npm scripts
```

---

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with nodemon (auto-reload on changes) |
| `npm start` | Production start |
| `npm test` | Run every Jest suite |
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
| `npm run build` | Build the frontend into `frontend/dist` |
| `npm run test:e2e` | Playwright browser tests against a real API and database |
| `npm run verify` | The local release gate: schema, Jest, build and browser tests |

---

## Additional Documentation

| Document | Description |
|----------|-------------|
| [Feature Status](docs/FEATURE_STATUS.md) | What works, what is limited, and what answers 501 |
| [API Reference](docs/API_REFERENCE.md) | The main endpoints of each module (not every endpoint) |
| [Sales Pilot](docs/SALES_PILOT.md) | Setting up and checking a pilot install |
| [Architecture Guide](docs/ARCHITECTURE.md) | System design, request lifecycle, module system, data layer, security layers |
| [Product Overview](docs/PRODUCT.md) | Non-technical product capabilities, feature descriptions, deployment options |
| [Changelog](docs/CHANGELOG.md) | Releases and notable changes |

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

Field definitions across 16 modules with 15 field types. **Custom fields
are definitions only for now:** no record form, list, report or export
shows them, and storing a value answers 501
(`CUSTOM_FIELD_VALUES_UNAVAILABLE`). The validation rules defined here do
apply on every save.

Guards worth knowing about: reserved names are rejected, a field's type
cannot change once records hold values (409 with the count, rather than
silently stranding data in the wrong column), and a picklist value still
in use is deactivated rather than deleted so historical records stay
readable.

Also covers dependent picklists, per-module layouts (stored only: no
screen uses them), and validation rules with a dry-run that reports how
many existing records would fail.

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

Two limits: the index is filled by explicit indexing calls, not when a
record is saved, so it falls behind; and the app's search box does not use
it, but `/api/search`, which matches substrings.

### Inbound Email (`/api/inbound-email`, 21 endpoints)

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
2. The visitor confirms the address. The request becomes `Verified`, and
   everyone who can approve access (`users: full`) is told: a notification
   in the app and an email each.
3. An administrator reviews it under **Access requests** in the app (or
   through the API) and approves it, which issues a `UserInvite`, or
   declines it. If the server sent no email (no SMTP, or it refused), the
   screen shows the invite link so it can be passed on by hand.
4. The invitee sets a password against the invite token. Only this
   step creates a `User`.

An administrator can also invite someone directly from the **Users**
screen. The same screen lists everyone who can sign in, and pending
invites. From it, someone with `users: full` can:
- change a person's name, email or role
- deactivate an account, which takes effect on their next request, or reactivate it
- email a one-time password reset link
- resend or revoke an invite

The API holds each change to the manager's own access. You can't
deactivate your own account, and the last active administrator can't
step down.

Tokens are stored as SHA-256 hashes, never in plaintext. An invite token
works once. A verification link can be opened again and says the address
is already confirmed, and does nothing else. Verification links last 48
hours, invites 7 days. The endpoint returns an identical response for
known and unknown addresses, so it cannot be used to enumerate accounts.
Disposable email domains are rejected. Public endpoints carry their own
tighter rate limits.

What a visitor typed is shown to reviewers as plain text: in the alert
email it is one line, cut to 300 characters, with links defused. Alert
emails are capped at 30 requests an hour per process, after which
reviewers are told in the app only.

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

The landing page quotes no route, model or endpoint counts.
`scripts/module-manifest.js` writes `frontend/src/moduleManifest.js` as an
empty stub, so the public site does not list the API's surface.

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
