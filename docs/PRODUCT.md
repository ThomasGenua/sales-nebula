# Sales Nebula CRM -- Product Overview

## What Is Sales Nebula?

Sales Nebula is a self-hosted CRM for one company's sales and service teams:
accounts, contacts, leads, deals, quotes, invoices and cases, with the rules,
approvals and automation that act on them. It runs on Node.js and PostgreSQL,
with a React app in a Bloomberg Terminal-inspired dark design.

It is not a Salesforce replacement feature for feature. Earlier versions of
this page claimed "complete Salesforce feature parity" and "132/132"
features; that was wrong, and the claim is withdrawn. Many modules store
configuration that nothing acts on yet, and where an action would do
nothing the API now refuses it with a 501 instead of reporting success.
[Feature status](FEATURE_STATUS.md) lists what works, what is limited and
what is unavailable.

## Who Is It For?

**Teams that want their CRM data on their own servers**, and need the core
records with real rules behind them: validation, duplicate and assignment
rules, workflows, approvals and an audit trail. There is no per-seat
licence.

**Developers** building on a REST API: every module has one, the standard
modules share one list, filter and write pattern, and webhooks and an OAuth
2.0 provider connect other systems.

**Not yet for teams that need:** mail and calendar sync with Gmail or
Outlook, e-signature, Slack, PDF documents, a mobile app, running visual
flows or AI agents, or several companies in one install. See
[Feature status](FEATURE_STATUS.md#not-built).

---

## Core Capabilities

### 1. Sales

**Leads** -- Capture leads from the web-to-lead form, imports, the API or by
hand. Assignment rules route new leads. Scoring rules score leads
from the web form automatically, and other leads on request.

**Deals** -- A pipeline with stages and probabilities, contact roles,
competitors, stage history, and velocity, aging and win/loss figures.

**Quotes and invoices** -- Quotes with line items, discounts and totals;
accepting a quote, turning it into an invoice or an order, and versions.
Quotes and invoices print from the browser; no PDF file is generated.

**Forecasts** -- Built from each owner's open deals in the period and
refreshed every 4 hours. Quotas are entered by managers.

**Territories** -- A territory hierarchy, with accounts mapped to territories
by hand. Territory assignment rules are stored but do not run yet.

### 2. Service and Support

**Cases** -- From the agent screen, the web-to-case form, email-to-case, a
connected Microsoft mailbox, or the API. SLA timers count business hours
only, and a case's status history is kept.

**Knowledge Base** -- Articles with categories, publishing and search.

**Field Service** -- Work orders that are dispatched, scheduled to a
technician and dates, completed or cancelled.

**Scheduler and Surveys** -- Appointment booking, and CSAT, NPS and CES
surveys with their responses.

### 3. Marketing

**Campaigns** -- Planning, members, recipients, responses and ROI. Sending a
campaign to its recipients is not available yet: the send action answers 501
and changes nothing. Individual sales emails go out when SMTP is set up.

**Email sequences** -- Multi-step sequences whose steps are sent every 10
minutes when SMTP is set up.

### 4. Automation

**One write path** -- Every save of a module's records, from a screen, an
import, the bulk API, a job or a conversion, runs the same rules: validation
on every save, duplicate and assignment rules on create, then audit,
workflows and webhooks.

**Workflows** -- Run on create, update, status change or a schedule, and
update fields, create tasks, notify people or send email.

**Approval processes** -- Sequential steps whose approver is a user, a role,
the submitter's manager or a queue, with entry conditions and final actions.

**Webhooks** -- Signed, retried, and logged outbound events.

### 5. AI and Analytics

**AI Copilot** -- Answers questions about your deals, cases and activities
using Claude when an Anthropic API key is set. Without one it answers from
fixed rules, and says so.

**Reports** -- Saved tabular, summary and chart reports that return real
figures, limited to what each viewer may see, with CSV and JSON export
through the API. Scheduled delivery is not available.

**Analytics** -- A pipeline and activity overview, an ad-hoc query, and
funnel and cohort figures.

AI agents, AI lead scoring and call transcription are not available.

### 6. Security and Administration

**Users** -- A Users screen to invite people, change their role, deactivate
and reactivate them, and send password resets. Public sign-up creates a
request that an administrator approves.

**Access control** -- Roles with read, edit or full access per module, and
row-level security from record owners, the role hierarchy, org-wide
defaults, sharing rules and security groups. Nobody can grant more access
than they hold.

**Sign-in** -- Passwords with account lockout, authenticator-app (TOTP)
two-factor, API keys, and Sales Nebula as an OAuth 2.0 provider for
connected apps. SSO through SAML or OIDC, SMS or email codes, IP rules,
field-level security and encryption policies are not available.

**Audit and monitoring** -- An audit log of record changes and audited
actions, kept 90 days, and login history.

**Privacy** -- Consent records with opt-in and opt-out, and a log of privacy
requests.

---

## Admin Dashboard

The Admin page shows system health (database, uptime, memory), record counts
across the main modules, security figures (sign-ins in the last 24 hours,
enrolled two-factor devices, active API keys), the revenue pipeline, pending
approvals, and the latest sign-ins and audit entries. It takes `admin: read`
and `users: read`.

---

## Technical Specifications

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 (LTS) |
| Framework | Express.js |
| ORM | Prisma |
| Database | PostgreSQL 16 (SQLite fallback in development) |
| Cache and queues | Redis 7, optional |
| Auth | JWT access and refresh tokens, httpOnly cookies in the browser |
| AI | Anthropic Claude API, optional |
| Container | Docker (Node 20 Alpine) |
| Frontend | React with Tailwind CSS, built with Vite |

### Size

Counted from the code in October 2026:

| Metric | Value |
|--------|-------|
| Database models | 286 |
| Route files | 100 |
| Frontend pages | 55 |
| Jest test files | 51 |
| Browser test specs | 5 |

No performance figures are claimed: the app has not been benchmarked.

---

## Deployment

### Docker (Recommended)

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, JWT_SECRET, INITIAL_ADMIN_EMAIL,
# INITIAL_ADMIN_PASSWORD and FRONTEND_URL, and configure SMTP.
docker compose up --build -d
```

This starts PostgreSQL, Redis and the API, applies the migrations and
creates the first administrator from `INITIAL_ADMIN_EMAIL`. Production
creates no demo users or records. The app is at `http://localhost:7544`;
sign in at `/login` with that administrator.

### Locally

```bash
npm run setup && npm start
```

See the [README](../README.md) for the seeded development administrator,
and [Sales pilot setup](SALES_PILOT.md) for a pilot install.

Full documentation: [README](../README.md), [Feature status](FEATURE_STATUS.md),
[API reference](API_REFERENCE.md), [Architecture](ARCHITECTURE.md).
