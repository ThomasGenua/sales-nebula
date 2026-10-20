# Sales Operations

Open **Sales Operations** in the main navigation. Each tab checks the same
module and record permissions as the underlying records.

## Daily workspace

Upcoming activity meetings and calendar occurrences for the next seven days,
unanswered personal mailbox threads, and the existing My Day task, lead and
stalled-deal queues share one page. Calendar recurrence is expanded by the
existing calendar engine. Mail is based on synced data, not a live inbox;
threads with a later synced outbound message are excluded. Mailbox content
is visible only to its owner, including when the caller is an administrator.
The unanswered-mail scan uses the newest 100 eligible inbound messages.

## Account 360

Choose an account to see visible contacts, deals, existing account-health
factors, and a date-ordered timeline of related activities, email, quotes,
orders, cases, contracts, invoices and calendar events. Activities and email
linked only to a visible child contact or deal are included. Private calendar
events retain their participant restrictions.

The page shows up to 200 timeline entries, drawn from the newest 100 per
module, with up to 5,000 visible contacts and deals. It does not claim to be
an exhaustive historical export. Create expansion opportunities here with
an explicit value, currency and close date.

## Deal coaching

Select a deal to edit a five-part qualification checklist, next step/date,
stage and competitor names. Manage buying-committee contacts and their roles.
The deal update uses the record version to reject stale edits.

Administrators can require checklist keys or nextStep, nextStepDate and
contactId for a given stage. Example:

```json
{"Proposal":["need","budget","nextStep"],"Negotiation":["authority","decisionProcess"]}
```

Requirements apply to every deal save through the central write service,
including API/import/automation writes. They start empty; existing sales
processes are not changed by installing the migration.

## Renewals and expansion

The renewal queue lists up to 100 activated or expired contracts due within
the chosen horizon, including overdue contracts. Create a renewal opportunity
or a dated reminder task. A unique database constraint prevents simultaneous
requests from creating two renewal opportunities for one contract. The
server-managed link cannot be edited or copied through ordinary deal writes.
Subsequent contract terms should use the existing contract-renewal action,
which creates a new contract that can have its own renewal opportunity.

Contract values do not have a currency column; the rep chooses the currency
when creating an opportunity. Reminder tasks appear in My Day when due.
This release does not automatically send renewal emails.

## Pipeline changes

Stage, value, currency, close date and owner changes are recorded on central
deal updates. Browse them by start date in pages of 50, with later close dates
marked as slipped. History starts when this release is installed; it cannot
reconstruct missing historical changes. Monetary changes are shown as raw
values rather than summed across currencies.

## Data-quality workbench

Review contacts, leads and accounts in pages of 50. Missing review fields and
records unchanged in 90 days are flagged. Exact, case-insensitive email
matches (names for accounts) identify potential duplicates; no fuzzy-match
claim is made. A comparison shows survivor/source values before invoking the
existing administrator merge. Merges require full module and record access
and execute supported relation transfers, survivor edits and source deletion
in one transaction.

Bulk cleanup supports a fixed set of text fields, at most 50 records per
request, with normal validation, audit, automation and record-access checks.
The response reports each record's outcome.

## Integration operations

Inspect personal mailbox sync status/errors and trigger the existing Outlook
sync action. Reconciliation counts show failed and unlinked personal messages
with a link to the mailbox for review. Administrators can see search queue
counts. Settings readers can see recent webhook delivery outcomes; full
settings access is required to retry a failed delivery on an enabled webhook.
A retry sends the stored payload again, so receivers should be idempotent.

Generic integration configurations still have no sync connector. Status is
based on recorded attempts, not a live external-provider probe. This release
does not claim live Outlook verification without deployed credentials.

## Configuration versions

Full administrators can export/import **workflow rules, validation rules and
deal stage requirements** as versioned JSON packages. Import is a replacement
of those three sets. The preview lists creates, updates and deletes. It checks
modules, supported rules/actions, and referenced active users/email templates.

Applying requires the preview's current-state and package hashes. A changed
package or configuration requires another preview. Application is one
serializable transaction; each revision retains before/after snapshots.
Loading an earlier version puts its previous state into the editor; it must
be validated and previewed again before restoration. Workflow IDs and
dependency IDs are retained, so cross-installation imports need matching
dependencies or edited mappings. Removed workflow logs follow the existing
database cascade; restoring configuration does not restore deleted logs.

These packages exclude customer records, credentials, permissions, custom
objects, flow definitions and hosting infrastructure. They do not provision
or deploy hosted sandboxes; those existing endpoints remain unavailable.

## Installation and validation

Run normal Prisma client generation and migration deployment. Migration
`20261020000000_sales_operations` adds deal coaching/renewal fields and
configuration revision storage. No new external service is required.

Regression tests are in `tests/salesOperations.test.js`; browser checks are in
`e2e/salesOperations.spec.js`. Both use disposable test databases.
