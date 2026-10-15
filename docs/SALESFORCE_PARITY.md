# Salesforce parity implementation

This is an incremental implementation of the eight-area roadmap, **not full
Salesforce parity**. The remaining items below are still part of the requested work.

## Implemented in this branch

- Custom-object fields and record editor. Creates, partial updates and imports
  use the same schema validation, defaults, finite numeric values, checkbox/date/
  picklist/email/URL checks, unique values and custom-object lookup checks.
  An object row lock serializes unique-value validation with saves.
- Forecast reconciliation adds eligible deals and removes deleted, closed,
  reassigned and out-of-period deals. Existing categories and overrides remain
  for eligible deals. Each refresh saves a snapshot. History and team attainment
  are visible in Forecasts; historical amounts are filtered by current deal access.
- Executable record-triggered and manual flows: acyclic connections, decisions,
  waits, field updates, related follow-up activities and owner notifications.
  Actions and checkpoints commit together; failed steps retry up to three times.
  The designer publishes drafts, previews paths, runs saved definitions and
  shows execution history. Editing a definition returns it to Draft. Existing
  runs retain their original graph. The scheduler resumes waiting runs each minute.
- Approval-process editor for entry conditions, ordered user/role/manager/queue
  steps and final field updates, using the existing approval engine.
- Quote-line price rules apply on line saves; validation product rules run on
  quote writes. Line discounts use currency amounts, as the quote schema does.
  Markups use the product's catalog price. Quote-level rules support setDiscount.
  Configured CPQ discount thresholds require a completed approval for the current
  quote version before acceptance or creating an order from it.
- Territory rule editor, preview and reconciliation. All active conditions must
  match. Account saves add/remove rule assignments while preserving manual ones.
  Applying changed rules updates existing accounts.
- Duplicate rules now check updates and exclude the current record.
- Record writes queue search-index maintenance. The minute worker coalesces
  repeated saves and reads current record state; failed items retain errors.

## Still required to complete the roadmap

1. Field-level permissions across all forms, APIs, reports, imports and exports.
   Configuration remains unavailable until enforcement is complete.
2. Record-type assignment and page-layout enforcement, including required fields,
   picklists and stage choices.
3. Rendered saved dashboards, shared filters/drilldowns, scheduled report delivery,
   matrix pivots and related-record reports.
4. Forecast snapshot comparison and additional manager editing controls.
5. Flow actions on arbitrary related records, richer typed field pickers and
   scheduled starts. Screen flows and loops are not supported.
6. Custom-object permissions, report/automation integration and a relationship
   record picker. Records currently retain the existing admin-module permissions.
   Custom formulas and relationships to standard CRM objects are not supported.
7. A complete pricing-rule editor, broader product selection/filter actions,
   and enforcement on every order-item mutation. Quote approval thresholds are
   configured through `POST /api/cpq/advanced/approval-matrix` using
   `{ name, discountPercent, processId }` with an active quote approval process.
8. Custom-object global search and a complete audit of older direct-write routes.
   Central record writes, workflow field updates and recycle-bin restores enqueue indexing.

## Operations

Apply migrations `20261015000000_forecast_snapshots` and
`20261015010000_quote_pricing_version`, and regenerate Prisma clients
before starting this version. Both Bull and node-cron register flow-resume and
search-index workers. Existing CI remains disabled; verification is local.

Live Outlook and external SMTP verification still require deployment credentials
and a designated test mailbox. These changes do not configure or deploy them.

## Verification

- 863 backend tests across 60 suites passed in three isolated database shards.
- Final workflow/forecast/pricing and approval regression reruns passed (28 and 13 tests).
- All 38 browser tests passed across the initial run and focused rerun.
- Production frontend build and Prisma-field checks passed.
- All 20 migrations applied to an empty database; Prisma reported no schema drift.
