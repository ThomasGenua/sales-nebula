# Enterprise foundations

This release extends seven areas of the CRM. It does not claim complete Salesforce parity.

## Field permissions

Sales Operations → Enterprise configuration provides role-specific visible/editable settings for the standard fields in the module catalog and Studio custom fields. Administrators retain full access. Unconfigured fields retain their existing permissions.

The request-scoped Prisma guard removes hidden standard fields, including nested related records, and rejects writes to hidden/read-only fields. Filtering, sorting and aggregation on hidden fields are refused rather than silently computing results from them. Studio values use the same policy. Imports, exports and report execution use the guarded client; central record writes also check the actor explicitly for background actions. Common module forms hide fields and disable read-only inputs. Module and row permissions still apply.

Historical JSON, audit entries, indexed search, forecasts and recycle-bin snapshots cannot always be safely projected by field. Those views refuse access for restricted users rather than returning old copies. Raw SQL is refused except for explicitly recognized identifier-only row locks. This can make some advanced operations unavailable to a restricted role. Field security is not text redaction: administrators must separately control access to emails, documents and other authored content containing copied information.

## Record types and layouts

Define a layout, then assign it to a record type. Types support eligible roles, a default flag, and field-specific allowed values, including deal stages. The shared record-write service enforces assignment, required fields, read-only fields and allowed values for creates and updates, including imports and automation. Schema defaults are included in validation.

Common record forms expose the type selector and render the assigned fields. Layouts affect presentation and validation; field permissions remain the security boundary. Layouts currently use standard scalar fields. Studio custom fields retain their own editor and validation. A record with an unavailable type requires reassignment before editing.

## Reports, dashboards and delivery

Reports supports two-dimensional matrices with totals and cell drilldowns. Related account/contact/deal fields are offered where a declared report relationship exists and the caller has target-module access. Each related record is checked against row access. Custom objects appear as report modules for users with object access.

Saved dashboards display saved reports, shared equality filters, summaries and record drilldowns. Every widget executes with the viewer's current access; a public dashboard does not grant access to private reports or records. Filters unavailable to a widget produce an error.

Report owners can schedule delivery to their own account email hourly, daily at 08:00 UTC, or Monday at 08:00 UTC. The existing minute worker claims due schedules, reruns with the owner's current permissions and records delivery success/failure. Output is JSON in the email body. SMTP must be configured; console logging is not counted as delivery. The UI shows next run, last delivery and the last error, and can cancel subscriptions. Delivery is at-most-once per claimed interval; a process failure after claiming may skip an interval rather than send a duplicate.

Matrix, related-record and custom-object processing is bounded at 10,000 source records. These paths fail explicitly over the limit. Related reports currently follow the registered account/contact/deal relationships, not arbitrary multi-hop joins.

Deal-value aggregations on these paths require a single currency after filtering so matrix totals cannot silently combine different currencies.

## Custom objects

Each object has its own permission module, `custom:<object-id>`, with none/read/edit/full access, managed in Enterprise configuration. Administrators can manage all objects. Object permissions govern record lists, writes, imports, search and reporting; definition changes still require administrative access. These are object-level permissions, not a new custom-record sharing hierarchy.

Lookup fields have a searchable record picker. Global search includes accessible custom objects and opens their records. Search scans the newest 1,000 records per object; it is bounded live search, not an unlimited custom-object index.

Custom records can trigger flows and be used in manual/scheduled flows. Custom flows support validated field updates and notifications. Fields use the existing custom-object type, required, unique and lookup validation.

## Automation

Field-update actions offer typed field/value controls. Related-record actions use declared CRM relationships, recheck actor module/row access, and update through the central write service. A step refuses more than 100 related records. Arbitrary joins, loops and screen flows are not supported.

Scheduled flows use intervals of 15–525,600 minutes. The existing minute worker atomically claims an interval and creates durable runs, which resume through the same checkpoint engine as other flows. A run uses the flow owner's current access. Each scheduled sweep supports at most 10,000 accessible source records and 200 matching records; exceeding either limit records a failure. Source conditions are evaluated before queuing matching runs. Editing returns a flow to Draft; publishing enables its next scheduled start.

## Pricing and orders

Sales Operations → Pricing rules edits active/inactive price and product rules, conditions, actions and priority. Price actions set prices, set currency-amount discounts or apply catalog-based markups. Product selection adds a configured product once; filtering rejects excluded products. Existing validation rules remain enforced.

Draft order lines now have add, update and delete endpoints with transactional repricing and totals. Failed validation rolls back the entire mutation. Discounts use currency amounts consistently with quotes. Direct total changes must agree with the stored lines. Linked-quote pricing changes require a revised quote and replacement order, and state transitions recheck the source quote and approval. Fulfilled, activated or cancelled orders cannot change lines.

Existing order lines are not backfilled. Editing a draft reprices its lines under the current rules and currency-amount discount convention.

## Forecasts

Forecast history compares two snapshots in the same currency, showing additions, removals, recategorization, amount changes and category deltas. Historical items are filtered by current record visibility; inaccessible/deleted records are not disclosed. Comparisons do not invent a reason for a removed deal. Existing manager/owner controls remain, with finite nonnegative override validation. Refresh saves a new snapshot; there is no historical backfill.

## Installation and verification

Apply `20261023000000_enterprise_foundations` and regenerate PostgreSQL and SQLite Prisma clients before starting the release. No production deployment, mail credentials or CI changes are included. Local validation results are recorded with the pull request.
