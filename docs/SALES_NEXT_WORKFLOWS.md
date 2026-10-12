# Sales workflow additions

Run `npm run prisma:generate`, deploy migrations with `npm run db:migrate:prod`,
and rebuild the frontend. Migration `20261011000000_sales_workflows` is additive.
GitHub Actions remain disabled according to the repository's existing policy.

## Email sequences

The sequence editor accepts `{{firstName}}`, `{{lastName}}`, `{{fullName}}`,
`{{company}}` and `{{email}}`. A contact's company comes from its linked account.
Missing values become blank text; unsupported placeholders are refused.

Sending windows specify an IANA time zone, weekdays, and start/end times within
one day. Daylight saving changes are handled in that time zone. Existing
sequences without a window keep their previous unrestricted schedule.

After a sequence sends, a new inbound message from that address stops its active
enrollment when it is next processed. The sender's personal mailbox and shared
support mailboxes are checked; another user's private messages are not used.
Mail must have synced first. This is a poll-based check, not an instant webhook.
The editor can turn stopping on replies off.

Every sequence email includes a signed unsubscribe link and List-Unsubscribe
headers. Opening the link shows a confirmation; confirming, or a mail client's
one-click POST, suppresses the address and stops matching active enrollments.
Suppressed or missing recipients do not advance through the sequence.
Changing a recipient's address pauses the enrollment; start a new enrollment
to send to the new address. SMTP delivery is still required, and delivery failures
still retry the current step.

Set `FRONTEND_URL` to the public HTTPS app origin so recipient links resolve
correctly. The signing key is `JWT_SECRET`; rotating it invalidates old
unsubscribe links, so retain the key while those emails remain in use.

## Custom fields

Studio definitions now store values in `StudioFieldValue`, linked to
`CustomFieldDef`. The older `CustomFieldValue` table belongs to the separate
legacy definition system and is unchanged.

Open a record's **Custom fields** form to edit values. Supported types are text,
long text, number, currency, percent, date, date/time, checkbox, dropdown,
multi-select, URL, email, and phone. Formula and related-record custom fields
remain unsupported. Read-only definitions cannot be changed from a record.
Required values are checked on this form and on imports; they do not make the
standard record create form require a second form's fields.

Saves validate the full custom-value set and commit it together. Limits,
picklist choices, required values, and uniqueness are checked; zero and false
remain valid values. Concurrent form edits are rejected using loaded versions.
Fields with values cannot change type or uniqueness until their data is removed.
Data-subject exports include these values, and erasure removes them.

Core record lists show custom columns and equality filters. Reports expose
reportable custom fields for columns, filters, grouping, measures, and CSV
export. Reports that use custom fields operate on up to 10,000 accessible
records after standard filters; larger sets require narrower standard filters
instead of silently computing incomplete totals.

## Workflow builder

The Workflows page edits record-created, record-updated, and status/stage-changed
triggers for leads, contacts, accounts, deals, activities, and cases.
Conditions use AND. Actions run in order: assign owner, create a follow-up with
a delay, notify the owner, update a field, or send email.

Owner assignment requires administrator edit permission and an active staff
member. Other actions retain the existing workflow permissions. Follow-ups link
to the triggering record, including leads. Preview evaluates a visible current
record without writing data or sending anything. Changed-value conditions
need a previous value and normally match only during a real update.
An active workflow runs on subsequent matching changes. Saved workflow logs
show the outcomes. The separate **Flows** feature is still not executable.

## Import wizard

Upload a CSV, map or skip its columns, edit previewed rows, and check the file.
The preview reports duplicates against accessible records and within the file,
plus errors at the original data-row number (the heading is excluded).
Choose to skip duplicates or update matching records you can edit.
Custom columns are named `custom.<field name>` in the API and mapping choices.

Each imported row and its custom values commit together. A failed row is
reported and skipped; other valid rows continue. Imports are not an all-file
transaction. A CSV with duplicate/empty headings, unclosed quotes, or inconsistent
column counts must be corrected before mapping.

## Customer quotes

Quote downloads are actual PDF files. The existing HTML preview remains
available. Customer links contain random 256-bit tokens; only token hashes are
stored. Creating a link snapshots customer-facing line items, totals, terms,
currency, and recipient names. Internal notes are excluded.

Links expire after 1–90 days, capped by the quote's validity date, and can be
revoked. Anyone holding a link can view that quote and submit acceptance with
a name, email, and explicit confirmation. The receipt records the accepted
version, signer details, and timestamp; it does not verify the signer's identity.
Changing the quote invalidates unaccepted links. Acceptance uses a version
check and transaction to avoid accepting a quote that changed concurrently.
Accepted snapshots remain immutable. Contact erasure revokes links and reports
retained quote snapshots/acceptance receipts in its residual-data list.

## Outlook calendar

Configure `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and optionally
`MICROSOFT_TENANT_ID`. Register `<FRONTEND_URL>/app/mailbox` as a web redirect URI.
From Mailbox or Calendar, choose **Enable Outlook calendar** and grant delegated
`Calendars.ReadWrite` in addition to the existing mailbox scopes.
Both email edit and activity edit permission are required.

The integration tracks the default Outlook calendar from 30 days ago through
180 days ahead using Microsoft Graph delta checkpoints, following pagination
and periodically renewing the window. It imports meetings, attendee responses,
and popup reminders. Imported events are private to the mailbox owner.
Deal/contact links remain in the CRM and are not sent to Microsoft.

**Sync calendar** pulls changes; the existing mailbox scheduler also pulls them.
**Publish and send Outlook invitations** explicitly publishes a locally saved
meeting or update. Microsoft sends invitations to its attendees. Cancellation
is also explicit. Creation uses a transaction ID to prevent duplicate remote
events on retries; updates use the remote version.

If both sides changed, sync preserves local edits and marks a conflict. The
owner can replace the local copy with the current Outlook version and edit
again. Meetings organized by someone else and recurring meetings are managed
in Outlook. Deleting a CRM record alone does not delete its Outlook meeting.
Disabling sync retains imported events.

## Validation and live setup

Local tests use disposable PostgreSQL databases, captured SMTP, and mocked
Microsoft responses. They cover access checks, typed custom values and imports,
quote expiry/revocation/acceptance, sequence controls, Outlook pagination,
attendees/reminders, and conflicts. Browser tests exercise the real API and UI.

On slow local disks, `TEST_DELETE_CLEANUP=true` opts into transactional deletion
between backend tests instead of recreating every table and index file. It
requires a PostgreSQL superuser on the disposable test database. Trigger
handling is restored when that cleanup transaction ends; normal test operations
still enforce database constraints. Accounts without that capability fall back
to the usual reset. The test-database name guard still applies. For slow local
disks, `TEST_BULK_IMPORT_TIMEOUT_MS=180000` increases the 450-row duplicate-import
test deadline without changing its assertions; the default remains 60 seconds.

A live Microsoft tenant/mailbox check still requires configured Microsoft
credentials and consent. Real SMTP delivery and public link reachability need
the deployed app URL and an approved test mailbox; neither is configured in
this checkout.

References: [Graph calendar delta](https://learn.microsoft.com/en-us/graph/delta-query-events),
[Graph event creation and attendee invitations](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0),
and [PDFKit](https://pdfkit.org/docs/getting_started.html).
