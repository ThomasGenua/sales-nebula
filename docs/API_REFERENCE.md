# Sales Nebula CRM -- Complete API Reference

> 576+ endpoints across 86 route modules. Every endpoint listed.

Base URL: `http://localhost:4000`

All endpoints require `Authorization: Bearer <token>` (or an `X-API-Key`) unless
marked **(public)**. The browser app uses a cookie session instead: sign in with
`X-Session-Mode: cookie`, then send the `sn_csrf` cookie's value as
`X-CSRF-Token` on every state-changing request.

Modules built with CRUD factory include: GET / (list), GET /:id, POST /, PUT /:id, DELETE /:id -- marked **[CRUD]**.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Users and Roles](#2-users-and-roles)
3. [Sales Cloud](#3-sales-cloud)
4. [Service Cloud](#4-service-cloud)
5. [Marketing Cloud](#5-marketing-cloud)
6. [Experience Cloud](#6-experience-cloud)
7. [Platform](#7-platform)
8. [Analytics and AI](#8-analytics-and-ai)
9. [Data and Integration](#9-data-and-integration)
10. [Security and Compliance](#10-security-and-compliance)
11. [Collaboration and Utilities](#11-collaboration-and-utilities)
12. [Administration](#12-administration)

---

## 1. Authentication

### `/api/auth`

Authentication and session management

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Authenticate user and get tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | Invalidate current session |
| GET | `/api/auth/me` | Get current authenticated user |
| POST | `/api/auth/register` | Register new user account |
| POST | `/api/auth/change-password` | Change user password |

### `/api/oauth`

OAuth provider (Google, Microsoft) login

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/oauth/google` | Authenticate via Google OAuth |
| POST | `/api/oauth/microsoft` | Authenticate via Microsoft OAuth |
| GET | `/api/oauth/config` | Get OAuth provider configuration |

---

## 2. Users and Roles

### `/api/users`

User CRUD, roles, permissions, preferences, online status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List all users |
| GET | `/api/users/:id` | Get user by ID |
| POST | `/api/users` | Create new user |
| PUT | `/api/users/:id` | Update user |
| DELETE | `/api/users/:id` | Delete user |
| GET | `/api/users/roles/all` | List all roles |
| POST | `/api/users/roles` | Create role |
| PUT | `/api/users/roles/:id` | Update role |
| DELETE | `/api/users/roles/:id` | Delete role |
| GET | `/api/users/online` | Get online users |
| GET | `/api/users/me/preferences` | Get user preferences |
| PUT | `/api/users/me/preferences` | Update user preferences |
| GET | `/api/users/me/activity` | Get current user activity log |

---

## 3. Sales Cloud

### `/api/leads` -- **[CRUD]**

Lead management with scoring, conversion, import

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/leads/:id/convert` | Convert lead to contact/account/deal |
| POST | `/api/leads/import-csv` | Create new lead |
| GET | `/api/leads/:id/duplicates` | List duplicates for lead |
| POST | `/api/leads/:id/score` | Get/update lead score |

### `/api/contacts` -- **[CRUD]**

Contact management with timeline, merge, import

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contacts/:id/timeline` | List timeline for contact |
| POST | `/api/contacts/:id/merge` | Merge duplicate contacts |
| POST | `/api/contacts/import-csv` | Create new contact |
| GET | `/api/contacts/:id/duplicates` | List duplicates for contact |

### `/api/accounts` -- **[CRUD]**

Account management with hierarchy, timeline, stats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts/:id/timeline` | List timeline for account |
| GET | `/api/accounts/:id/stats` | Get account statistics |
| POST | `/api/accounts/:id/merge` | Merge duplicate accounts |
| POST | `/api/accounts/:id/clone` | Clone account |

### `/api/person-accounts` -- **[CRUD]**

B2C individual person accounts

### `/api/deals` -- **[CRUD]**

Full deal pipeline with stats, line items, clone, competitors

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/deals/stats/pipeline` | Get deal pipeline statistics |
| GET | `/api/deals/:id/timeline` | List timeline for deal |
| GET | `/api/deals/stats/velocity` | Get deal velocity metrics |
| GET | `/api/deals/:id/line-items` | List deal line items |
| POST | `/api/deals/:id/line-items` | Add line item to deal |
| DELETE | `/api/deals/:id/line-items/:itemId` | Remove line item from deal |
| POST | `/api/deals/:id/clone` | Clone deal |
| GET | `/api/deals/:id/competitors` | List competitors for deal |
| PUT | `/api/deals/:id/competitors` | Update competitors for deal |
| GET | `/api/deals/stats/aging` | Get deal aging analysis |
| GET | `/api/deals/stats/win-loss` | Get win/loss rate statistics |
| POST | `/api/deals/:id/submit` | Submit deal for approval |
| GET | `/api/deals/stats/rollup` | Get deal rollup summary |

### `/api/deals`

Deal contact roles, revenue splits, stage history

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/deals/:id/contact-roles` | List contact roles for deal |
| POST | `/api/deals/:id/contact-roles` | Add contact roles to deal |
| DELETE | `/api/deals/:id/contact-roles/:roleId` | Remove contact roles from deal |
| GET | `/api/deals/:id/splits` | List splits for deal |
| POST | `/api/deals/:id/splits` | Add splits to deal |
| DELETE | `/api/deals/:id/splits/:splitId` | Remove splits from deal |
| GET | `/api/deals/:id/history` | Get deal history |

### `/api/products` -- **[CRUD]**

Product catalog with categories, bundles, active toggle

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/products/categories/list` | List product categories |
| GET | `/api/products/catalog/active` | List active product catalog |
| POST | `/api/products/:id/clone` | Clone product |
| PUT | `/api/products/:id/toggle-active` | Update toggle active for product |
| GET | `/api/products/stats/overview` | Get product statistics overview |

### `/api/quotes`

Quote management with PDF, accept, invoice generation

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/quotes` | List all quotes |
| GET | `/api/quotes/:id` | Get quote by ID |
| POST | `/api/quotes` | Create new quote |
| PUT | `/api/quotes/:id` | Update quote |
| POST | `/api/quotes/:id/accept` | Add accept to quote |
| POST | `/api/quotes/:id/create-invoice` | Add create invoice to quote |
| DELETE | `/api/quotes/:id` | Delete quote |
| GET | `/api/quotes/:id/pdf` | Generate quote PDF |

### `/api/quotes`

Quote templates and line items with auto-calculated totals

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/quotes/templates` | List quote templates |
| POST | `/api/quotes/templates` | Create new quote |
| PUT | `/api/quotes/templates/:id` | Update quote |
| GET | `/api/quotes/:id/line-items` | List quote line items |
| POST | `/api/quotes/:id/line-items` | Add line item to quote |
| DELETE | `/api/quotes/:id/line-items/:itemId` | Remove line item from quote |

### `/api/orders` -- **[CRUD]**

Order processing with activation and quote conversion

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/orders/:id/activate` | Activate order |
| POST | `/api/orders/from-quote/:quoteId` | Create new order |

### `/api/contracts` -- **[CRUD]**

Contract lifecycle with activation and renewal

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/contracts/:id/activate` | Activate contract |
| POST | `/api/contracts/:id/renew` | Renew contract |

### `/api/invoices`

Invoice management with PDF, payment, statistics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/invoices` | List all invoices |
| GET | `/api/invoices/:id` | Get invoice by ID |
| POST | `/api/invoices` | Create new invoice |
| PUT | `/api/invoices/:id` | Update invoice |
| POST | `/api/invoices/:id/pay` | Add pay to invoice |
| DELETE | `/api/invoices/:id` | Delete invoice |
| GET | `/api/invoices/stats/summary` | Get invoice summary |
| GET | `/api/invoices/:id/pdf` | Generate invoice PDF |

### `/api/subscriptions` -- **[CRUD]**

Recurring subscription management

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/subscriptions/:id/cancel` | Cancel subscription |
| POST | `/api/subscriptions/:id/renew` | Renew subscription |

### `/api/revenue`

Revenue schedules with period-based recognition

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/revenue/schedules` | List revenue recognition schedules |
| POST | `/api/revenue/schedules` | Create revenue recognition schedule |
| POST | `/api/revenue/schedules/:id/recognize` | Add recognize to revenue recognition |

### `/api/forecasts`

Revenue forecasting with quotas, rollups, approval

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/forecasts` | List all forecasts |
| GET | `/api/forecasts/:id` | Get forecast by ID |
| POST | `/api/forecasts` | Create new forecast |
| PUT | `/api/forecasts/:id` | Update forecast |
| PUT | `/api/forecasts/:id/items/:itemId` | Update items for forecast |
| POST | `/api/forecasts/:id/submit` | Submit forecast for approval |
| POST | `/api/forecasts/:id/approve` | Approve forecast |
| GET | `/api/forecasts/:id/rollup` | List rollup for forecast |
| GET | `/api/forecasts/stats/rollup` | Get forecast rollup summary |
| DELETE | `/api/forecasts/:id` | Delete forecast |

### `/api/territories`

Territory models, hierarchies, and assignment

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/territories/models` | List territory models |
| POST | `/api/territories/models` | Create new territory |
| PUT | `/api/territories/models/:id` | Update territory |
| GET | `/api/territories` | List all territories |
| POST | `/api/territories` | Create new territory |
| PUT | `/api/territories/:id` | Update territory |
| DELETE | `/api/territories/:id` | Delete territory |
| POST | `/api/territories/:id/assign` | Assign records to territory |
| DELETE | `/api/territories/:id/assign/:assignId` | Assign territory to user |

### `/api/sales-path`

Guided selling stages with coaching content

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sales-path` | List all sales paths |
| GET | `/api/sales-path/:module/current/:stage` | Get current sales path stage guidance |
| POST | `/api/sales-path` | Create new sales path |
| PUT | `/api/sales-path/:id` | Update sales path |
| DELETE | `/api/sales-path/:id` | Delete sales path |

### `/api/teams`

Account and deal team member assignments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/teams/account/:accountId` | List team members on account |
| POST | `/api/teams/account/:accountId` | Add team member to account |
| PUT | `/api/teams/account/:accountId/:memberId` | Update team member role on account |
| DELETE | `/api/teams/account/:accountId/:memberId` | Remove team member from account |
| GET | `/api/teams/deal/:dealId` | List team members on deal |
| POST | `/api/teams/deal/:dealId` | Add team member to deal |
| PUT | `/api/teams/deal/:dealId/:memberId` | Update team member role on deal |
| DELETE | `/api/teams/deal/:dealId/:memberId` | Remove team member from deal |

### `/api/partners` -- **[CRUD]**

Partner relationship management with tiers

### `/api/assets` -- **[CRUD]**

Installed product/asset tracking with lifecycle status

### `/api/cpq`

Configure-Price-Quote: bundles, pricebooks, pricing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cpq/bundles` | List product bundles |
| GET | `/api/cpq/bundles/:id` | Get CPQ by ID |
| POST | `/api/cpq/bundles` | Create product bundle |
| PUT | `/api/cpq/bundles/:id` | Update CPQ |
| DELETE | `/api/cpq/bundles/:id` | Delete CPQ |
| POST | `/api/cpq/bundles/:id/configure` | Add configure to CPQ |
| GET | `/api/cpq/pricebooks` | List price books |
| POST | `/api/cpq/pricebooks` | Create price book |
| PUT | `/api/cpq/pricebooks/:id` | Update CPQ |
| POST | `/api/cpq/price` | Calculate product pricing |
| GET | `/api/cpq/discount-schedules` | List discount schedules |
| POST | `/api/cpq/discount-schedules` | Create discount schedule |
| DELETE | `/api/cpq/discount-schedules/:id` | Delete CPQ |

### `/api/cpq/advanced`

Product rules, price rules, guided selling, discount tiers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cpq/advanced/product-rules` | List advanced product rules |
| POST | `/api/cpq/advanced/product-rules` | Create product rule |
| PUT | `/api/cpq/advanced/product-rules/:id` | Update product rules for CPQ |
| DELETE | `/api/cpq/advanced/product-rules/:id` | Delete product rule |
| GET | `/api/cpq/advanced/price-rules` | List advanced price rules |
| POST | `/api/cpq/advanced/price-rules` | Create price rule |
| PUT | `/api/cpq/advanced/price-rules/:id` | Update price rule |
| GET | `/api/cpq/advanced/guided-selling` | Get guided selling configuration |
| POST | `/api/cpq/advanced/guided-selling` | Run guided selling flow |
| POST | `/api/cpq/advanced/guided-selling/recommend` | Get guided selling recommendation |
| GET | `/api/cpq/advanced/discount-schedules` | List discount schedules |
| POST | `/api/cpq/advanced/discount-schedules` | Create discount schedule |
| POST | `/api/cpq/advanced/discount-schedules/calculate` | Calculate discount from schedule |
| POST | `/api/cpq/advanced/validate-quote` | Validate quote configuration |

---

## 4. Service Cloud

### `/api/cases` -- **[CRUD]**

Case management with comments, escalation, resolution

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/cases/:id/comments` | List case comments |
| POST | `/api/cases/:id/escalate` | Escalate case |
| POST | `/api/cases/:id/resolve` | Add resolve to case |
| GET | `/api/cases/stats/overview` | Get case statistics overview |

### `/api/public/email-to-case`

Inbound email auto-creates cases. The inbound endpoints are a webhook for the
mail provider: they require `EMAIL_TO_CASE_SECRET`, sent as an
`X-Webhook-Secret` header or as the HTTP basic auth password, and answer 503
while it is unset.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/public/email-to-case/inbound` | Receive inbound email for case creation |
| POST | `/api/public/email-to-case/inbound/bulk` | Receive up to 50 inbound emails in one call |
| GET | `/api/public/email-to-case/config` | Get public configuration |
| PUT | `/api/public/email-to-case/config` | Update email-to-case configuration |

### `/api/public/web-to-case`

Web form submission creates cases (public)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/public/web-to-case` | Submit web-to-case form |

### `/api/knowledge`

Knowledge articles with categories, versioning, search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/knowledge` | List all knowledge articles |
| GET | `/api/knowledge/:id` | Get knowledge article by ID |
| GET | `/api/knowledge/slug/:slug` | Get knowledge article by URL slug |
| POST | `/api/knowledge` | Create new knowledge article |
| PUT | `/api/knowledge/:id` | Update knowledge article |
| POST | `/api/knowledge/:id/publish` | Publish knowledge article |
| POST | `/api/knowledge/:id/new-version` | Add new version to knowledge article |
| POST | `/api/knowledge/:id/vote` | Add vote to knowledge article |
| DELETE | `/api/knowledge/:id` | Delete knowledge article |
| GET | `/api/knowledge/categories/all` | List all knowledge categories |
| POST | `/api/knowledge/categories` | Create knowledge category |
| GET | `/api/knowledge/stats/overview` | Get knowledge base statistics |

### `/api/entitlements` -- **[CRUD]**

Service entitlements with milestones and consumption

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/entitlements/:id/milestones` | Add milestones to entitlement |
| GET | `/api/entitlements/check/:accountId` | Check entitlements for account |
| POST | `/api/entitlements/:id/consume` | Add consume to entitlement |

### `/api/omnichannel`

Work routing, agent presence, chat sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/omnichannel/channels` | List omnichannel channels |
| POST | `/api/omnichannel/channels` | Create omnichannel channel |
| PUT | `/api/omnichannel/channels/:id` | Update omnichannel channel |
| GET | `/api/omnichannel/queue` | Get omnichannel work queue |
| POST | `/api/omnichannel/route` | Route work item to agent |
| POST | `/api/omnichannel/queue/:id/accept` | Add accept to omnichannel |
| POST | `/api/omnichannel/queue/:id/complete` | Mark omnichannel as complete |
| POST | `/api/omnichannel/queue/:id/transfer` | Transfer omnichannel ownership |
| GET | `/api/omnichannel/chat` | Get live chat sessions |
| POST | `/api/omnichannel/chat` | Start live chat session |
| POST | `/api/omnichannel/chat/:id/accept` | Add accept to omnichannel |
| POST | `/api/omnichannel/chat/:id/message` | Add message to omnichannel |
| POST | `/api/omnichannel/chat/:id/end` | Add end to omnichannel |

### `/api/field-service` -- **[CRUD]**

Work orders, line items, service appointments

### `/api/macros`

Automated multi-step action sequences

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/macros` | List all macros |
| POST | `/api/macros` | Create new macro |
| PUT | `/api/macros/:id` | Update macro |
| DELETE | `/api/macros/:id` | Delete macro |
| POST | `/api/macros/:id/execute` | Execute macro |

### `/api/scheduler`

Appointment slots, booking, availability

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/scheduler/slots` | Get available appointment slots |
| POST | `/api/scheduler/slots` | Create new appointment |
| PUT | `/api/scheduler/slots/:id` | Update appointment |
| POST | `/api/scheduler/slots/:id/book` | Add book to appointment |
| POST | `/api/scheduler/slots/:id/cancel` | Cancel appointment |
| GET | `/api/scheduler/availability` | Get agent availability |

### `/api/surveys`

CSAT/NPS/CES surveys with analytics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/surveys` | List all surveys |
| GET | `/api/surveys/:id` | Get survey by ID |
| POST | `/api/surveys` | Create new survey |
| PUT | `/api/surveys/:id` | Update survey |
| DELETE | `/api/surveys/:id` | Delete survey |
| POST | `/api/surveys/:id/respond` | Add respond to survey |
| GET | `/api/surveys/:id/analytics` | List analytics for survey |

---

## 5. Marketing Cloud

### `/api/campaigns` -- **[CRUD]**

Campaign management with members, recipients, ROI

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/campaigns/:id/send` | Send campaign |
| POST | `/api/campaigns/:id/recipients` | Add recipients to campaign |
| GET | `/api/campaigns/:id/recipients` | List recipients for campaign |
| GET | `/api/campaigns/stats/overview` | Get campaign statistics overview |

### `/api/campaign-influence`

Multi-touch revenue attribution

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/campaign-influence/deal/:dealId` | Get campaign influence on deal |
| GET | `/api/campaign-influence/campaign/:campaignId` | Get contacts influenced by campaign |
| POST | `/api/campaign-influence` | Create new campaign influence |
| POST | `/api/campaign-influence/calculate/:dealId` | Calculate campaign influence for deal |

### `/api/emails`

Email templates, drafts, sending, tracking

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/emails` | List all emails |
| GET | `/api/emails/:id` | Get email by ID |
| POST | `/api/emails` | Create new email |
| POST | `/api/emails/send` | Create new email |
| POST | `/api/emails/:id/send` | Send email |
| POST | `/api/emails/:id/track-open` | Add track open to email |
| PUT | `/api/emails/:id` | Update email |
| DELETE | `/api/emails/:id` | Delete email |
| GET | `/api/emails/templates/all` | List all email templates |
| POST | `/api/emails/templates` | Create email template |
| PUT | `/api/emails/templates/:id` | Update email |
| DELETE | `/api/emails/templates/:id` | Delete email |

### `/api/sequences`

Multi-step drip campaigns with enrollment

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sequences` | List all sequences |
| GET | `/api/sequences/:id` | Get sequence by ID |
| POST | `/api/sequences` | Create new sequence |
| PUT | `/api/sequences/:id` | Update sequence |
| DELETE | `/api/sequences/:id` | Delete sequence |
| POST | `/api/sequences/:id/activate` | Activate sequence |
| POST | `/api/sequences/:id/pause` | Pause sequence |
| POST | `/api/sequences/:id/enroll` | Enroll contacts in sequence |
| POST | `/api/sequences/:id/unenroll` | Add unenroll to sequence |
| POST | `/api/sequences/process` | Create new sequence |

---

## 6. Experience Cloud

### `/api/portal`

Experience Cloud portal configuration and users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portal` | List all portals |
| POST | `/api/portal` | Create new portal |
| PUT | `/api/portal/:id` | Update portal |
| GET | `/api/portal/:id/users` | List users for portal |
| POST | `/api/portal/:id/users` | Add users to portal |

### `/api/chatter`

Chatter feed with posts, comments, likes (legacy)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chatter/feed` | Get chatter feed |
| GET | `/api/chatter/my-feed` | Get personal chatter feed |
| POST | `/api/chatter` | Create new chatter |
| POST | `/api/chatter/:id/comments` | List chatter comments |
| POST | `/api/chatter/:id/like` | Add like to chatter |
| POST | `/api/chatter/:id/pin` | Pin/unpin chatter |
| DELETE | `/api/chatter/:id` | Delete chatter |
| PUT | `/api/chatter/:id` | Update chatter |

### `/api/feed`

Activity feed with posts, comments, likes, pins

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/feed` | List all feeds |
| POST | `/api/feed` | Create new feed |
| DELETE | `/api/feed/:id` | Delete feed |
| POST | `/api/feed/:id/like` | Add like to feed |
| POST | `/api/feed/:id/pin` | Pin/unpin feed |
| POST | `/api/feed/:id/comments` | List feed comments |

---

## 7. Platform

### `/api/custom-objects`

Dynamic schema with typed fields and JSONB records

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/custom-objects` | List all custom objects |
| POST | `/api/custom-objects` | Create new custom object |
| PUT | `/api/custom-objects/:id` | Update custom object |
| DELETE | `/api/custom-objects/:id` | Delete custom object |
| POST | `/api/custom-objects/:id/fields` | Add field to custom object |
| DELETE | `/api/custom-objects/:id/fields/:fieldId` | Remove fields from custom object |
| GET | `/api/custom-objects/:id/records` | List records for custom object |
| POST | `/api/custom-objects/:id/records` | Create record in custom object |
| PUT | `/api/custom-objects/:id/records/:recordId` | Update records for custom object |
| DELETE | `/api/custom-objects/:id/records/:recordId` | Remove records from custom object |

### `/api/custom-code`

Server-side script management and execution

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/custom-code` | List all custom codes |
| GET | `/api/custom-code/:id` | Get custom code by ID |
| POST | `/api/custom-code` | Create new custom code |
| PUT | `/api/custom-code/:id` | Update custom code |
| DELETE | `/api/custom-code/:id` | Delete custom code |
| POST | `/api/custom-code/:id/execute` | Execute custom code |
| POST | `/api/custom-code/:id/validate` | Add validate to custom code |

### `/api/custom-components`

UI component registry and preview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/custom-components` | List all custom components |
| GET | `/api/custom-components/:id` | Get custom component by ID |
| POST | `/api/custom-components` | Create new custom component |
| PUT | `/api/custom-components/:id` | Update custom component |
| DELETE | `/api/custom-components/:id` | Delete custom component |
| POST | `/api/custom-components/:id/preview` | Preview custom component |

### `/api/configuration`

Validation rules, record types, page layouts, OWD, FLS, role hierarchy

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/configuration/validation-rules` | List validation rules |
| POST | `/api/configuration/validation-rules` | Create validation rule |
| PUT | `/api/configuration/validation-rules/:id` | Update validation rule |
| DELETE | `/api/configuration/validation-rules/:id` | Delete validation rule |
| POST | `/api/configuration/validate/:module` | Validate configuration for module |
| GET | `/api/configuration/record-types` | List record types |
| POST | `/api/configuration/record-types` | Create record type |
| PUT | `/api/configuration/record-types/:id` | Update record type |
| DELETE | `/api/configuration/record-types/:id` | Delete record type |
| GET | `/api/configuration/page-layouts` | List page layouts |
| POST | `/api/configuration/page-layouts` | Create page layout |
| PUT | `/api/configuration/page-layouts/:id` | Update page layout |
| DELETE | `/api/configuration/page-layouts/:id` | Delete page layout |
| GET | `/api/configuration/owd` | Get org-wide defaults |
| PUT | `/api/configuration/owd/:module` | Update org-wide default for module |
| GET | `/api/configuration/field-permissions` | List field-level permissions |
| POST | `/api/configuration/field-permissions` | Set field-level permission |
| POST | `/api/configuration/field-permissions/bulk` | Bulk update field permissions |
| GET | `/api/configuration/role-hierarchy` | Get role hierarchy tree |
| PUT | `/api/configuration/role-hierarchy/:roleId` | Update role hierarchy position |

### `/api/flows`

Visual flow builder with versioning and execution

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/flows` | List all flows |
| GET | `/api/flows/:id` | Get flow by ID |
| POST | `/api/flows` | Create new flow |
| PUT | `/api/flows/:id` | Update flow |
| POST | `/api/flows/:id/activate` | Activate flow |
| POST | `/api/flows/:id/run` | Add run to flow |
| DELETE | `/api/flows/:id` | Delete flow |

### `/api/workflows`

Rule-based automation with logs and manual trigger

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workflows` | List all workflows |
| GET | `/api/workflows/:id` | Get workflow by ID |
| POST | `/api/workflows` | Create new workflow |
| PUT | `/api/workflows/:id` | Update workflow |
| POST | `/api/workflows/:id/toggle` | Add toggle to workflow |
| POST | `/api/workflows/:id/duplicate` | Check for workflow duplicates |
| DELETE | `/api/workflows/:id` | Delete workflow |
| GET | `/api/workflows/logs/all` | Get all workflow execution logs |
| POST | `/api/workflows/execute` | Create new workflow |

### `/api/approvals`

Multi-step approval processes and requests

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/approvals/processes` | List approval processes |
| POST | `/api/approvals/processes` | Create new approval |
| PUT | `/api/approvals/processes/:id` | Update approval |
| DELETE | `/api/approvals/processes/:id` | Delete approval |
| GET | `/api/approvals/requests` | List approval requests |
| GET | `/api/approvals/requests/pending` | List pending approval requests |
| POST | `/api/approvals/requests` | Create new approval |
| POST | `/api/approvals/requests/:id/approve` | Approve approval |
| POST | `/api/approvals/requests/:id/reject` | Reject approval |
| POST | `/api/approvals/requests/:id/recall` | Recall approval from approval |

### `/api/events`

Platform events pub/sub with subscriptions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/events/publish` | Publish platform event |
| GET | `/api/events/history` | Get platform event history |
| GET | `/api/events/subscriptions` | List event subscriptions |
| POST | `/api/events/subscriptions` | Create event subscription |
| PUT | `/api/events/subscriptions/:id` | Update event |
| DELETE | `/api/events/subscriptions/:id` | Delete event subscription |

### `/api/environments`

Sandboxes, metadata export/import, change sets

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/environments` | List all environments |
| POST | `/api/environments` | Create new environment |
| POST | `/api/environments/:id/refresh` | Add refresh to environment |
| DELETE | `/api/environments/:id` | Delete environment |
| GET | `/api/environments/change-sets` | List environment change sets |
| POST | `/api/environments/change-sets` | Create change set |
| PUT | `/api/environments/change-sets/:id` | Update environment |
| POST | `/api/environments/change-sets/:id/deploy` | Add deploy to environment |
| GET | `/api/environments/metadata/export` | Export environment metadata |
| POST | `/api/environments/metadata/import` | Import environment metadata |

### `/api/formulas`

Calculated fields with evaluation and bulk processing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/formulas` | List all formulas |
| POST | `/api/formulas` | Create new formula |
| PUT | `/api/formulas/:id` | Update formula |
| DELETE | `/api/formulas/:id` | Delete formula |
| POST | `/api/formulas/test` | Create new formula |
| POST | `/api/formulas/evaluate` | Evaluate formula expression |
| POST | `/api/formulas/evaluate-bulk` | Create new formula |

---

## 8. Analytics and AI

### `/api/dashboard`

Executive KPI dashboard with leaderboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard` | List all dashboards |
| GET | `/api/dashboard/leaderboard` | Get sales leaderboard |

### `/api/reports`

Report builder with folders, scheduling, export, clone

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports/metadata` | Get report metadata/field definitions |
| GET | `/api/reports` | List all reports |
| GET | `/api/reports/:id` | Get report by ID |
| POST | `/api/reports` | Create new report |
| PUT | `/api/reports/:id` | Update report |
| DELETE | `/api/reports/:id` | Delete report |
| POST | `/api/reports/:id/execute` | Execute report |
| POST | `/api/reports/execute` | Create new report |
| POST | `/api/reports/:id/export` | Add export to report |
| POST | `/api/reports/preview` | Create new report |
| GET | `/api/reports/folders/all` | List all report folders |
| POST | `/api/reports/folders` | Create report folder |
| DELETE | `/api/reports/folders/:id` | Delete report |
| POST | `/api/reports/:id/schedule` | Add schedule to report |
| DELETE | `/api/reports/schedule/:id` | Delete report |
| POST | `/api/reports/:id/clone` | Clone report |

### `/api/analytics`

Datasets, dashboards, queries, report types, schedules

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics/datasets` | List analytics datasets |
| POST | `/api/analytics/datasets` | Create analytics dataset |
| POST | `/api/analytics/datasets/:id/refresh` | Add refresh to analytics |
| GET | `/api/analytics/dashboards` | List analytics dashboards |
| POST | `/api/analytics/dashboards` | Create analytics dashboard |
| PUT | `/api/analytics/dashboards/:id` | Update analytics dashboard |
| POST | `/api/analytics/query` | Run analytics query |
| GET | `/api/analytics/report-types` | List analytics report types |
| POST | `/api/analytics/report-types` | Create analytics report type |
| GET | `/api/analytics/scheduled-reports` | List scheduled analytics reports |
| POST | `/api/analytics/scheduled-reports` | Schedule analytics report |
| PUT | `/api/analytics/scheduled-reports/:id` | Update scheduled analytics report |
| DELETE | `/api/analytics/scheduled-reports/:id` | Delete scheduled analytics report |

### `/api/ai-agents`

Configurable AI agents with execution history

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai-agents` | List all AI agents |
| GET | `/api/ai-agents/:id` | Get AI agent by ID |
| POST | `/api/ai-agents` | Create new AI agent |
| PUT | `/api/ai-agents/:id` | Update AI agent |
| DELETE | `/api/ai-agents/:id` | Delete AI agent |
| POST | `/api/ai-agents/:id/run` | Add run to AI agent |
| GET | `/api/ai-agents/:id/runs` | List AI agent execution runs |

### `/api/ai`

Inline AI features (chat, deal coach, pipeline forecast)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ai/chat` | AI chat completion |
| POST | `/api/ai/deal-coach` | AI deal coaching suggestions |
| POST | `/api/ai/pipeline-forecast` | AI-powered pipeline forecasting |

### `/api/copilot`

Conversational AI assistant with threading

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/copilot/conversations` | List copilot conversations |
| POST | `/api/copilot/conversations` | Start copilot conversation |
| POST | `/api/copilot/ask` | Ask copilot a question |
| POST | `/api/copilot/actions` | Execute copilot action |

### `/api/conversation-intelligence`

Call recording, transcription, sentiment, dialer

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversation-intelligence/recordings` | List call recordings |
| POST | `/api/conversation-intelligence/recordings` | Upload call recording |
| POST | `/api/conversation-intelligence/recordings/:id/analyze` | Add analyze to conversation intelligence |
| GET | `/api/conversation-intelligence/dialer/status` | Get dialer status |
| POST | `/api/conversation-intelligence/dialer/call` | Initiate outbound call |
| POST | `/api/conversation-intelligence/dialer/:id/connect` | Add connect to conversation intelligence |
| POST | `/api/conversation-intelligence/dialer/:id/end` | Add end to conversation intelligence |

---

## 9. Data and Integration

### `/api/import`

CSV/Excel import wizard with validation

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/import/metadata` | Get import field mappings metadata |
| POST | `/api/import/validate` | Validate import data before execution |
| POST | `/api/import/execute` | Execute data import |

### `/api/export`

Data export by module

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/export/:module` | Export module records to file |

### `/api/data-export`

Data export job management with download

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/data-export` | List all data exports |
| POST | `/api/data-export` | Create new data export |
| GET | `/api/data-export/:id/download` | List download for data export |

### `/api/bulk`

High-volume batch operations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/bulk/insert` | Bulk insert records |
| POST | `/api/bulk/update` | Bulk update records |
| POST | `/api/bulk/upsert` | Bulk upsert records |
| POST | `/api/bulk/delete` | Bulk delete records |
| POST | `/api/bulk/query` | Run bulk data query |

### `/api/mass-actions`

Bulk update, delete, reassign, tag operations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mass-actions/update` | Mass update field values |
| POST | `/api/mass-actions/delete` | Mass delete records |
| POST | `/api/mass-actions/reassign` | Create new mass action |
| POST | `/api/mass-actions/tag` | Create new mass action |
| POST | `/api/mass-actions/untag` | Create new mass action |
| POST | `/api/mass-actions/add-to-campaign` | Create new mass action |

### `/api/webhooks`

Outbound webhooks with HMAC signing and retry

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/webhooks` | List registered webhooks |
| GET | `/api/webhooks/:id` | Get webhook by ID |
| POST | `/api/webhooks` | Create new webhook |
| PUT | `/api/webhooks/:id` | Update webhook |
| DELETE | `/api/webhooks/:id` | Delete webhook |
| POST | `/api/webhooks/:id/regenerate-secret` | Add regenerate secret to webhook |
| POST | `/api/webhooks/:id/test` | Send test webhook |
| GET | `/api/webhooks/:id/logs` | List logs for webhook |
| GET | `/api/webhooks/events/list` | List available webhook event types |

### `/api/integrations`

Third-party integrations with email sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/integrations` | List configured integrations |
| POST | `/api/integrations` | Create new integration |
| PUT | `/api/integrations/:id` | Update integration |
| DELETE | `/api/integrations/:id` | Delete integration |
| POST | `/api/integrations/:id/test` | Test integration |
| POST | `/api/integrations/slack/notify` | Create new integration |
| GET | `/api/integrations/email-sync` | Get email sync status |
| POST | `/api/integrations/email-sync` | Create new integration |
| POST | `/api/integrations/email-sync/:id/sync` | Add sync to integration |
| DELETE | `/api/integrations/email-sync/:id` | Delete integration |

### `/api/connected-apps`

OAuth 2.0 client applications, and the authorization server they use (see "Connected Apps (OAuth 2.0)" in the README)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/connected-apps` | List all connected apps |
| POST | `/api/connected-apps` | Register a connected app; the client secret is returned once |
| PUT | `/api/connected-apps/:id` | Update a connected app's name, redirect URIs, scopes or status |
| DELETE | `/api/connected-apps/:id` | Delete a connected app and every grant to it |
| POST | `/api/connected-apps/:id/revoke` | Disable a connected app and end every grant to it |
| POST | `/api/connected-apps/:id/rotate-secret` | Issue a new client secret, returned once |
| GET | `/api/connected-apps/oauth/authorize` | Check an authorization request for the consent screen (the user's own session) |
| POST | `/api/connected-apps/oauth/authorize` | Record the user's decision; returns the redirect back to the app |
| POST | `/api/connected-apps/oauth/token` | Exchange a code (with its PKCE verifier) or a refresh token for tokens |
| POST | `/api/connected-apps/oauth/revoke` | End the grant behind an access or refresh token |
| GET | `/api/connected-apps/authorizations` | The apps the signed-in user has authorized |
| DELETE | `/api/connected-apps/authorizations/:appId` | Revoke the signed-in user's authorization of an app |

### `/api/marketplace`

App listings, install, reviews

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/marketplace` | List all marketplace listings |
| GET | `/api/marketplace/:id` | Get marketplace listing by ID |
| POST | `/api/marketplace` | Create new marketplace listing |
| PUT | `/api/marketplace/:id` | Update marketplace listing |
| POST | `/api/marketplace/:id/install` | Install marketplace app |
| POST | `/api/marketplace/:id/uninstall` | Add uninstall to marketplace listing |
| GET | `/api/marketplace/:id/installations` | List installations for marketplace listing |

### `/api/cdp`

Customer Data Platform with profiles, segments, streams

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cdp/profiles` | List all CDPs |
| GET | `/api/cdp/profiles/:id` | Get unified CDP profile |
| POST | `/api/cdp/profiles/resolve` | Create new CDP |
| POST | `/api/cdp/profiles/:id/merge` | Merge duplicate CDPs |
| POST | `/api/cdp/segments/calculate` | Create new CDP |
| GET | `/api/cdp/streams` | List all CDPs |
| POST | `/api/cdp/streams` | Create new CDP |
| POST | `/api/cdp/streams/:id/ingest` | Add ingest to CDP |

### `/api/mobile`

Device registration, push notifications, sync

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mobile/devices` | Register mobile device |
| DELETE | `/api/mobile/devices/:deviceId` | Bulk delete mobiles |
| POST | `/api/mobile/push` | Send push notification |
| GET | `/api/mobile/notifications` | List mobile notifications |
| GET | `/api/mobile/feed` | Get mobile activity feed |
| POST | `/api/mobile/sync` | Sync data for offline use |

---

## 10. Security and Compliance

### `/api/security`

SSO, MFA, encryption policies

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/security/sso` | List SSO configurations |
| POST | `/api/security/sso` | Create SSO configuration |
| PUT | `/api/security/sso/:id` | Update SSO configuration |
| POST | `/api/security/sso/login` | Initiate SSO login flow |
| GET | `/api/security/mfa/devices` | List MFA devices |
| POST | `/api/security/mfa/enroll` | Enroll MFA device |
| POST | `/api/security/mfa/verify` | Verify MFA code |
| POST | `/api/security/mfa/challenge` | Issue MFA challenge |
| DELETE | `/api/security/mfa/devices/:id` | Remove devices from security |
| GET | `/api/security/encryption/policies` | List encryption policies |
| POST | `/api/security/encryption/policies` | Create encryption policy |
| PUT | `/api/security/encryption/policies/:id` | Update policies for security |
| POST | `/api/security/encryption/rotate-key` | Rotate encryption key |
| GET | `/api/security/encryption/keys` | List encryption keys |

### `/api/sharing`

Sharing rules, record sharing, access check

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sharing/rules` | List sharing rules |
| POST | `/api/sharing/rules` | Create sharing rule |
| PUT | `/api/sharing/rules/:id` | Update sharing rule |
| DELETE | `/api/sharing/rules/:id` | Delete sharing rule |
| POST | `/api/sharing/records` | Share record with user/group |
| GET | `/api/sharing/records/:module/:recordId` | List sharing grants for record |
| DELETE | `/api/sharing/records/:id` | Delete sharing rule |
| GET | `/api/sharing/check/:module/:recordId` | Check user access to record |

### `/api/consent`

GDPR consent records with self-service opt-out

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/consent` | List all consent records |
| POST | `/api/consent` | Record consent preference |
| PUT | `/api/consent/:id` | Update consent record |
| POST | `/api/consent/opt-out` | Process opt-out request |

### `/api/monitoring`

Login history, event logs, summary

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/monitoring/login-history` | Get login history log |
| GET | `/api/monitoring/event-logs` | Get platform event logs |
| GET | `/api/monitoring/event-logs/summary` | Get monitoring summary |

### `/api/duplicates`

Duplicate detection rules, check, merge

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/duplicates/rules` | List duplicate matching rules |
| POST | `/api/duplicates/rules` | Create duplicate matching rule |
| PUT | `/api/duplicates/rules/:id` | Update duplicate |
| DELETE | `/api/duplicates/rules/:id` | Delete duplicate |
| POST | `/api/duplicates/check/:module` | Create new duplicate |
| POST | `/api/duplicates/merge/:module` | Create new duplicate |

### `/api/recycle-bin`

30-day soft delete recovery

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/recycle-bin` | List soft-deleted records |
| POST | `/api/recycle-bin/:id/restore` | Restore recycle bin from archive |
| DELETE | `/api/recycle-bin/:id` | Delete recycle bin |
| POST | `/api/recycle-bin/empty` | Empty all items from recycle bin |
| GET | `/api/recycle-bin/stats` | Get recycle bin statistics |

---

## 11. Collaboration and Utilities

### `/api/activities` -- **[CRUD]**

Tasks, calls, meetings with calendar and stats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activities/overdue/list` | List all activitys |
| GET | `/api/activities/today/list` | List all activitys |
| GET | `/api/activities/calendar/range` | List all activitys |
| POST | `/api/activities/:id/complete` | Mark activity as complete |
| POST | `/api/activities/:id/reschedule` | Add reschedule to activity |
| GET | `/api/activities/stats/summary` | Get activity summary |
| POST | `/api/activities/log-call` | Create new activity |
| POST | `/api/activities/log-meeting` | Create new activity |

### `/api/timeline`

Unified activity timeline for any record

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/timeline/:module/:recordId` | Get activity timeline for record |

### `/api/notes`

Rich text notes with pinning

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notes/:module/:recordId` | List notes for record |
| POST | `/api/notes/:module/:recordId` | Create new note |
| PUT | `/api/notes/:id` | Update note |
| DELETE | `/api/notes/:id` | Delete note |
| POST | `/api/notes/:id/pin` | Pin/unpin note |

### `/api/documents` -- **[CRUD]**

Document management with upload

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/documents/upload` | Upload file as document |

### `/api/attachments`

File attachments on any parent record

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/attachments` | List all attachments |
| POST | `/api/attachments` | Create new attachment |
| DELETE | `/api/attachments/:id` | Delete attachment |

### `/api/tags`

Universal tagging with assignment and search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tags` | List all tags |
| POST | `/api/tags` | Create new tag |
| PUT | `/api/tags/:id` | Update tag |
| DELETE | `/api/tags/:id` | Delete tag |
| GET | `/api/tags/record/:module/:recordId` | List tags on record |
| POST | `/api/tags/assign` | Create new tag |
| DELETE | `/api/tags/assign/:module/:recordId/:tagId` | Bulk delete tags |
| POST | `/api/tags/bulk-assign` | Create new tag |
| GET | `/api/tags/search/:module/:tagId` | Find records with specific tag |

### `/api/views`

Saved list view filters and columns

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/views/:module` | List all saved views |
| POST | `/api/views` | Create new saved view |
| PUT | `/api/views/:id` | Update saved view |
| DELETE | `/api/views/:id` | Delete saved view |
| POST | `/api/views/:id/set-default` | Add set default to saved view |

### `/api/search`

Global cross-module search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search` | Global cross-module search |

---

## 12. Administration

### `/api/admin`

System config, custom fields, audit, scoring, SLA, API keys, currencies

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/config` | Get system configuration |
| PUT | `/api/admin/config` | Update system configuration |
| GET | `/api/admin/custom-fields` | List custom field definitions |
| POST | `/api/admin/custom-fields` | Create custom field definition |
| PUT | `/api/admin/custom-fields/:id` | Update custom field definition |
| DELETE | `/api/admin/custom-fields/:id` | Delete custom field definition |
| GET | `/api/admin/audit-log` | Get audit log entries |
| GET | `/api/admin/notifications` | List user notifications |
| POST | `/api/admin/notifications/mark-read` | Mark notifications as read |
| GET | `/api/admin/stats` | Get admin statistics |
| GET | `/api/admin/export/:module` | Export module data |
| GET | `/api/admin/export` | Export all data |
| GET | `/api/admin/scoring-rules` | List lead scoring rules |
| POST | `/api/admin/scoring-rules` | Create lead scoring rule |
| PUT | `/api/admin/scoring-rules/:id` | Update lead scoring rule |
| DELETE | `/api/admin/scoring-rules/:id` | Delete lead scoring rule |
| POST | `/api/admin/score-all-leads` | Trigger lead scoring for all leads |
| GET | `/api/admin/assignment-rules` | List assignment rules |
| POST | `/api/admin/assignment-rules` | Create assignment rule |
| PUT | `/api/admin/assignment-rules/:id` | Update assignment rule |
| DELETE | `/api/admin/assignment-rules/:id` | Delete assignment rule |
| GET | `/api/admin/sla-policies` | List SLA policies |
| POST | `/api/admin/sla-policies` | Create SLA policy |
| PUT | `/api/admin/sla-policies/:id` | Update SLA policy |
| DELETE | `/api/admin/sla-policies/:id` | Delete SLA policy |
| GET | `/api/admin/jobs` | List available background jobs |
| POST | `/api/admin/jobs/:name` | Run background job by name |
| GET | `/api/admin/api-keys` | List API keys |
| POST | `/api/admin/api-keys` | Generate new API key |
| PUT | `/api/admin/api-keys/:id` | Update API key |
| DELETE | `/api/admin/api-keys/:id` | Revoke API key |
| GET | `/api/admin/export-csv/:module` | Export module data as CSV |
| GET | `/api/admin/currencies` | List currencies |
| POST | `/api/admin/currencies` | Add currency |
| PUT | `/api/admin/currencies/:id` | Update currency |
| DELETE | `/api/admin/currencies/:id` | Delete currency |
| POST | `/api/admin/currencies/convert` | Convert amount between currencies |

### `/api/admin/dashboard`

System health, record counts, security metrics, recent activity

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/dashboard/system` | Get system health dashboard |
| GET | `/api/admin/dashboard/activity` | Get system activity dashboard |

---

## Infrastructure (app-level)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/metrics` | Get  metrics |
| POST | `/api/public/web-to-lead` | Submit web-to-lead form |
| GET | `/api/public/track/:emailId` | Track email open via pixel |
| GET | `/api/health` | Get system health check |

## Query Parameters (Standard CRUD)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number |
| `limit` | integer | 50 | Records per page (max 200) |
| `search` | string | -- | Full-text search |
| `sort` | string | `createdAt` | Sort field |
| `order` | string | `desc` | `asc` or `desc` |

## Response Formats

**List:** `{ "data": [...], "meta": { "total": 142, "page": 1, "limit": 50, "pages": 3 } }`

**Single record:** Object directly.

**Error:** `{ "error": "message" }`

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Validation error |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not found |
| 409 | Conflict |
| 429 | Rate limited |
| 500 | Server error |