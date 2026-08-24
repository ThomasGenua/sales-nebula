# Changelog

All notable changes to Sales Nebula CRM.

## v1.0.0 -- Production Release

### Platform Totals
- 173 database models with 253 indexes
- 576+ API endpoints across 86 route modules
- 28 frontend pages (Bloomberg Terminal aesthetic)
- 246 automated tests
- 132/132 Salesforce feature parity + 39 bonus models

### Core CRM
- Lead management with web-to-lead, scoring, assignment rules, CSV import, duplicate detection
- Contact management with merge, timeline, import, duplicate detection
- Account management with hierarchy, timeline, stats, merge, clone
- Person Accounts for B2C individual accounts
- Deal pipeline with stages, probability, line items, clone, competitors, contact roles, revenue splits, stage history, velocity analytics, aging, win/loss analysis, approval submission
- Product catalog with categories, bundles, discount schedules, clone, active toggle
- Quote management with PDF export, accept/reject, invoice generation, templates, line items with auto-calculated totals
- Order processing with activation and quote conversion
- Contract lifecycle with activation and renewal
- Invoice management with PDF export, payment tracking, statistics
- Subscription management with cancel and renew
- Revenue recognition with schedules and period-based entries
- Revenue forecasting with quota management, rollups, submit/approve workflow
- Territory management with models, hierarchical territories, assignment rules
- Sales path with stage-specific coaching content
- Team assignments for accounts and deals
- Partner management with tiers (Registered/Silver/Gold/Platinum)
- Asset tracking with lifecycle status

### Configure-Price-Quote (CPQ)
- Product bundles with configuration
- Pricebook management with entries
- Price calculation engine
- Discount schedules with tier calculation
- Product rules (compatibility, exclusion)
- Price rules (volume, term-based)
- Guided selling questionnaires with product recommendations
- Quote validation against all rules

### Service Cloud
- Case management with comments, escalation, resolution, statistics
- Email-to-case (public inbound endpoint)
- Web-to-case (public form endpoint)
- Knowledge base with articles, categories, versioning, publishing, voting, search
- Entitlements with milestones and consumption tracking
- Omnichannel routing with channels, queue, agent presence, chat sessions
- Field service with work orders, line items, service appointments
- Macros for automated multi-step actions
- Appointment scheduler with slots, booking, cancellation, availability
- Surveys (CSAT/NPS/CES/Custom) with response collection and analytics

### Marketing Cloud
- Campaign management with members, recipients, target lists, ROI tracking, send
- Multi-touch campaign influence attribution
- Email templates, drafts, sending, open/click tracking
- Email sequences with multi-step drip campaigns, enrollment, pause/activate

### Experience Cloud
- Portal configuration (Customer/Partner/Employee) with themes and self-registration
- Portal user provisioning with bcrypt passwords
- Chatter feed (legacy) with posts, comments, likes, pins
- Activity feed with text/link/content/poll posts, likes, pins, comments

### Platform
- Custom objects with dynamic fields and JSONB records
- Custom fields extending any module
- Validation rules with formula-based logic
- Record types with multiple layouts per module
- Page layouts for field arrangement
- Formula fields with cross-object evaluation
- Flow builder with versioning, activation, execution history
- Workflow automation with field updates, email alerts, task creation
- Multi-step approval processes with configurable approvers
- Platform events (pub/sub) with subscriptions
- Environments (sandboxes) with metadata export/import and change sets
- Custom code execution (Apex-equivalent)
- Custom UI components (Lightning-equivalent)

### Analytics and AI
- Report builder with types, folders, scheduling, export, clone, preview
- Analytics datasets and interactive dashboards
- Executive KPI dashboard with leaderboard
- AI agents powered by Anthropic Claude with execution history
- Copilot conversational AI with message threading
- Conversation intelligence with call recording, transcription, sentiment analysis
- Inline AI features (deal coaching, pipeline forecast)

### Data and Integration
- CSV/Excel import wizard with field mapping, validation, error reporting
- Data export in CSV, JSON, XLSX formats with job tracking
- Bulk API for high-volume batch operations (insert/update/upsert/delete/query)
- Mass actions (bulk update, delete, reassign, tag, campaign add)
- Webhooks with HMAC-SHA256 signing, exponential retry, delivery logs
- Third-party integration management with connection testing
- Email sync configuration
- Connected apps (OAuth2 client management)
- OAuth2 authorization server
- Marketplace for app listings, install, reviews
- Customer Data Platform with profiles, identity resolution, segments, data streams
- Mobile device registration, push notifications, offline sync

### Security and Compliance
- JWT authentication with dual tokens (access + refresh)
- Role-based access control with three-tier permissions (read/edit/full)
- Sharing rules and org-wide defaults
- Field-level security per role/module/field
- Role hierarchy with record access inheritance
- SSO configuration (SAML 2.0, OIDC)
- MFA enrollment and verification (TOTP, SMS)
- Platform encryption policies with key rotation
- GDPR consent management with self-service opt-out
- Login history tracking with IP, browser, status
- Event logs (Shield) with risk scoring
- API key authentication for server-to-server
- Account lockout after failed attempts
- Bcrypt password hashing
- Helmet.js security headers (15 policies)
- Rate limiting per IP
- XSS input sanitization
- Duplicate detection and merge

### Collaboration
- Activities (tasks, calls, meetings) with overdue tracking, calendar, quick logging
- Unified timeline for any record
- Rich text notes with pinning
- Document management with upload and versioning
- File attachments on any record (polymorphic)
- Universal tagging with assignment tracking and search
- Saved views per module with default setting
- Global cross-module search

### Administration
- System configuration management
- Custom field administration
- Complete audit trail
- Notification system
- Lead scoring and assignment rule management
- SLA policy management
- Background job control
- API key management
- Multi-currency with exchange rates and conversion
- Recycle bin with 30-day retention, restore, purge
- Admin dashboard with system health, record counts, security metrics, revenue pipeline, automation stats, recent activity

### Infrastructure
- Docker Compose deployment (PostgreSQL, Redis, API, migration)
- Multi-stage Alpine Dockerfile (~150MB)
- Health check endpoint with database connectivity verification
- Graceful shutdown (SIGTERM/SIGINT)
- Pino structured JSON logging
- Prometheus metrics endpoint
- OpenAPI/Swagger spec generation
- Database backup utility
- 246 automated tests (Jest + supertest)

### Bug Fixes (Final Audit)
- Fixed `deals.js` missing `requirePermission` import (runtime crash on submit/rollup)
- Fixed `environments.js` referencing `prisma.workflowRule` instead of `prisma.workflow`
- Removed duplicate `territories.js` registration in app.js
- Resolved `/api/cpq` route prefix conflict between cpq.js and advancedCpq.js

## [4.1.0] - 2026-02-28

### Backend: All Routes Deepened
- **Zero thin routes remaining**: All 86 routes now 80+ lines with real business logic
- Previously 33 routes under 80 lines; all have been expanded with:
  - Full CRUD with validation and search
  - Domain-specific business operations
  - Relationship queries and aggregations
  - Audit trail integration
  - Bulk operations where applicable

### Routes deepened (previously stub/thin):
- **assets** (4->117): Lifecycle management, warranty checks, service history, bulk status
- **partners** (4->92): Performance metrics, certifications, deal registration, tier evaluation
- **personAccounts** (4->88): Convert to account+contact, merge, stats
- **attachments** (8->106): Multi-file upload, download tracking, metadata, bulk upload
- **monitoring** (8->96): Login history, event logs, real-time metrics, alerts, deep health check
- **consent** (9->113): GDPR consent management, preferences, opt-out, data subject requests
- **portal** (10->109): Config, user management, contact-to-portal-user, self-service cases
- **feed** (11->89): Activity feed, comments, likes, real-time events
- **scheduler** (11->121): Appointments, conflict detection, slot availability, agent routing
- **surveys** (12->157): Create/publish, questions, responses, NPS/CSAT analytics
- **territories** (14->121): Hierarchy tree, members, account assignment, performance metrics
- **dealExtras** (15->111): Contact roles, stage history, deal health scoring, similar deals
- **quoteExtras** (11->113): Approval flow, bulk discount, clone, convert-to-order, comparison
- **fieldService** (40->120): Schedule, dispatch, complete with service report, route optimization
- **customComponents** (42->88): Full CRUD, activate/deactivate, clone, bulk, export
- **marketplace** (52->108): Install/uninstall, reviews/ratings, listing management
- **export** (53->82): Multi-format (JSON/CSV), filtered export, available modules, history
- **customCode** (54->87): Activate/deactivate, syntax testing, execution logs, versioning
- **documents** (55->110): File upload/download, bulk upload, versioning, category search
- **entitlements** (57->80): Account check, consume, renew, usage reporting
- **subscriptions** (58->101): Renew, cancel, plan change, MRR/ARR metrics
- **aiAgents** (59->105): Run agents (SDR/DealCoach/Service), run history, performance metrics
- **integrations** (61->89): Sync trigger, sync logs, connection test, email sync
- **copilot** (62->133): AI chat with threads, actions (create task/log call/update deal)
- **emailToCase** (62->100): Thread matching, priority detection, bulk inbound, routing rules
- **salesPath** (62->86): Stage guidance, progress tracking, stage management
- **webToCase** (49->85): Rate limiting, contact auto-create, embed snippet, stats
- **conversationIntelligence** (65->136): Recording, transcript analysis, insights, dialer
- **revenueRecognition** (66->108): Revenue schedules, period recognition, summary analytics
- **macros** (71->88): Execute on records, bulk execute, execution counting
- **contracts** (72->105): Activate, terminate, amend, renew, compliance check
- **environments** (74->117): Deploy, compare, change sets, metadata export/import
- **customObjects** (76->124): Full field CRUD, dynamic records, schema export
- **mobile** (82->114): Device registration, push notifications, offline sync (pull+push)

### Frontend: Full Mobile Responsiveness
- **Bottom navigation bar**: 5-tab quick access (Home, Deals, Contacts, Tasks, More)
- **Mobile drawer**: Full-width slide-out navigation with all 28 pages
- **Responsive data tables**: Automatic card view on mobile, table on desktop with toggle
- **Bottom-sheet modals**: Slide-up on mobile, centered on desktop with drag handle
- **Touch-optimized**: 44px minimum touch targets, touch-manipulation, active states
- **Safe area support**: Notched device padding (iPhone X+)
- **iOS input zoom prevention**: 16px font-size on mobile inputs
- **Dynamic viewport**: 100dvh for proper mobile chrome handling
- **PWA-ready**: Theme color, web-app-capable meta tags
- **Responsive grids**: 1-col mobile -> 2-col tablet -> 4-col desktop throughout
- **52 component functions** with consistent mobile-first responsive patterns

## [4.2.0] - 2026-02-28

### Backend: Deep Route Enhancement Phase 2
- **ALL 86 routes now 130+ lines** (up from 80+)
- **40 routes at 150+ lines** with sophisticated business logic
- **13 routes at 200+ lines** (admin, reports, deals, etc.)
- Total route code: 14,700+ lines (up from 12,300)
- Total backend JavaScript: 17,500+ lines

### New Route Capabilities Added:
- **contacts**: Merge contacts, duplicate checking, relationship graph, convert-to-lead
- **notes**: Pin/unpin, parent-scoped notes, full-text search, bulk delete
- **teams**: Performance metrics, leaderboard with revenue/activity ranking
- **search**: Search history, autocomplete suggestions, module-specific search
- **views**: Clone views, set default per user, view sharing
- **products**: Pricing tiers, inventory tracking, clone, bundle support
- **analytics**: Sales funnel analysis, cohort analysis, activity effectiveness
- **monitoring**: Performance metrics over time, alert rules CRUD, storage metrics
- **integrations**: Sync scheduling, field mapping CRUD, integration health checks
- **ai**: Prediction history, batch lead scoring, deal win probability prediction
- **aiAgents**: Conversation history, training data management, agent analytics
- **contracts**: Milestones, renewal forecasting
- **dashboard**: My widgets (tasks, stale deals, overdue), leaderboard
- **cases**: SLA tracking, escalation workflow, satisfaction surveys, case metrics
- **feed**: Module-scoped feed, mentions, feed stats, bulk posting
- **cdp**: Customer profiles with lifetime value, event tracking, segment evaluation
- **bulkApi**: Bulk upsert (create-or-update), bulk query, job status
- **omnichannel**: Queue stats, agent presence, intelligent routing, channel metrics
- **customObjects**: Record search, relationship graph, schema validation, bulk import
- **campaignInfluence**: Multi-touch attribution, ROI by campaign
- **partners**: Pipeline view, commission tracking, scorecard
- **timeline**: Unified record timeline (activities+notes+feed+emails), timeline stats
- **tags**: Usage stats, bulk assignment, tag merging
- **marketplace**: App settings, featured apps
- **revenueRecognition**: Deferred revenue aging, revenue by product
- **export**: Scheduled exports, export templates, field options

### Frontend: Deep Mobile Responsiveness Enhancement
- **1,947 lines** (up from 1,254) with 52+ component functions
- **New Components Added**:
  - FilterPanel: slide-out on mobile, inline on desktop with active filter count
  - RecordDetail: Full record view with tabs, related lists, metadata
  - MiniBarChart: Responsive sparkline bar charts with hover values
  - DonutChart: SVG donut with legend, responsive layout
  - NotificationPanel: Slide-from-right notification drawer
  - QuickActions: Command palette (Ctrl+K) with keyboard shortcuts
  - ActivityTimeline: Color-coded activity timeline with badges
  - KpiRow: Scrollable horizontal metrics strip for mobile
  - InlineEdit: Click-to-edit with save/cancel
  - ProgressBar: Animated progress with labels
- **Enhanced ModulePage**: Detail view on record click, filter panel integration, bulk delete, sort support
- **Enhanced Dashboard**: KPI strip, bar charts, donut chart, recent deals list, activity timeline
- **Deep Settings Page**: 4 tabs (Profile, Security, Notifications, System) with full forms
- **Enhanced TopBar**: Quick actions trigger (desktop search bar + mobile icon), notification bell
- **Enhanced AppShell**: Keyboard shortcuts (Ctrl+K), notification/quick-action state management

## [4.2.0] - 2026-02-28

### Backend: Deep Route Expansion (Round 2)
- **14 routes now 200+ lines** (up from 13)
- **72 routes now 131-199 lines** (up from previous moderate range)
- **Total route code: 15,431 lines** (up from 12,333)
- **Total backend JS: 18,246 lines** (up from 15,148)

### Routes deepened further:
- **accounts** (131->225): Relationship graph (contacts/deals/cases/invoices/contracts), health score (factor-based 0-100), account merge (transfer all records, fill blank fields), account hierarchy (parent/children/siblings)
- **timeline** (131->180): Timeline analytics (by type/month, avg per week), aggregate timeline across records, bulk timeline event creation
- **campaignInfluence** (131->182): Attribution model comparison (first-touch/last-touch/linear), campaign ROI calculation with influenced revenue
- **copilot** (133->182): Record insights (deal stall detection, contact gaps, case volume warnings), suggested next actions (overdue tasks, stalled deals, pending approvals, new leads)
- **security** (133->178): Threat detection (brute force IP analysis, bulk export monitoring), active session listing, IP allowlist/blocklist management
- **teams** (134->180): Team performance analytics (member-level deal/revenue stats), workload distribution (open deals/tasks/cases per member)
- **recycleBin** (135->185): Recycle bin statistics by module, bulk restore, permanent purge with age cutoff
- **connectedApps** (134->172): App usage analytics (API calls, error rates), client secret rotation, connection testing
- **cdp** (136->187): Segment evaluation with criteria matching, journey analytics with step-level metrics, profile unification across contact/lead/case/campaign
- **views** (137->168): Clone views, share with teams, usage tracking
- **mobile** (143->191): Device management (list/remove), push notification preferences (per-type + quiet hours), offline conflict resolution
- **subscriptions** (134->166): Churn risk prediction (expiring non-auto-renew), cohort analysis with retention rates
- **environments** (134->157): Deployment history with user info, rollback capability
- **marketplace** (134->156): App dependency checking, featured/trending apps listing
- **portal** (132->157): Portal analytics (active users, self-service rate), branding configuration (logo, colors, custom CSS)
- **attachments** (132->153): Per-record attachment statistics, system-wide recent attachments feed
- **assets** (134->156): Utilization report (active rate by status), warranty expiring soon report

### Frontend: Massive Page Expansion
- **43 routable pages** (up from 28)
- **78 component functions** (up from 52)
- **2,137 total lines** (up from 1,254)
- **All mobile-responsive** with bottom nav, drawer, cards, bottom-sheet modals

### New frontend pages (15 added):
- **Reports**: Card grid view, run reports in modal, create new reports with module/type selection
- **Surveys**: Full CRUD with status badges (Draft/Published/Closed), response count tracking
- **Territories**: CRUD with type selection (Region/State/City/Custom)
- **Documents**: CRUD with category filtering, download count display, file size
- **Tags**: CRUD with color picker, module assignment, usage count
- **Webhooks**: CRUD with URL and active status badge
- **Partners**: CRUD with tier badges (Registered/Silver/Gold/Platinum), type classification
- **Assets**: CRUD with lifecycle status (Purchased through Decommissioned), warranty tracking
- **Notes**: CRUD with parent module linking
- **Sequences**: Email sequence management with status and enrollment tracking
- **Approvals**: Pending/history tab interface, approve/reject inline actions with badges
- **Analytics**: Overview dashboard with conversion rate, avg deal size, sales cycle, activity metrics
- **AI Copilot**: Full chat interface with message bubbles, typing indicator, Send button, auto-scroll
- **Chatter**: Social feed with post composition, like/comment counters, author avatars, timestamp
- **Recycle Bin**: Module-tabbed interface with deletion stats, per-item restore buttons
- **Import**: Module selector with drag-and-drop upload zone
