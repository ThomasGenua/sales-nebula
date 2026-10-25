# Revenue workflows

The Sales Operations workspace now includes Payments, Computed fields, Campaign delivery, Deal rooms, and Account success. The existing sequence editor supports email, call, manual LinkedIn, and task steps. These features require the normal module permissions; background jobs recheck the initiating user's active status and access.

## Cadences

Enrollments snapshot the steps they start with. Call, LinkedIn and task steps create one assigned Activity, which also appears in My Day. Complete it with a supported outcome to continue or take a forward branch. `converted` records an explicit conversion; it does not infer a sale from a closed deal. Conversion reporting counts only accessible people. LinkedIn steps are manual work instructions, not an automated LinkedIn API integration. SMTP is needed for email steps; manual steps work without SMTP.

## Computed fields

Configure formulas and count/sum/average/min/max rollups in Computed fields. Supported relationships: account to deals/invoices/cases; contact to deals; deal to activities. Values appear as read-only `custom.ff_*` fields in Studio record sections, list filters and reports. Workflow and flow conditions can reference these keys. Parent writes and scheduled evaluations recompute values; child changes do not independently trigger a parent workflow. Historical `changed` conditions on rollups are not supported: both evaluations use the current child records.

Rollups include only rows the evaluating user can read. Definitions are withheld when source or child fields are hidden. Mixed-currency monetary sums are refused. Filtering and rollups are capped at 10,000 records; narrow large datasets. Values are calculated on demand, not stored as authoritative financial balances.

## Stripe and invoices

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and an HTTPS `FRONTEND_URL`. Configure a Stripe webhook at `/api/public/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Keep the raw request body intact. The handler checks the timestamp and HMAC, retrieves the Checkout Session from Stripe, and matches the stored amount, currency and checkout ID before adding a ledger entry. Replayed events do not duplicate payments. A manual Check payment action is also available.

Payments supports full or partial Checkout links, reference-based manual receipts, real invoice PDFs and opt-in weekly overdue reminders. Reminders require SMTP and an accessible invoice contact; suppressions apply. Currency support for Checkout is USD, CAD, EUR, GBP, AUD, NZD and CHF. Each invoice/payment is limited to 21,474,836.47 currency units. Existing positive Paid invoices up to 21,474,836.47 currency units receive a legacy opening ledger entry. Review historical invoices above that range before enabling payment collection.

Invoices with receipts cannot change totals/currency or replace line items. Actual Stripe overpayments are preserved as a credit for reconciliation. Refunds, disputes, tax calculation, automatic bank matching and credit-note issuance are not implemented. A provider timeout can leave a Pending checkout; inspect Stripe before creating another link. Return-page text is informational; the ledger is the source of payment status.

## Gmail and Google Calendar

Enable Gmail API and Google Calendar API in your Google Cloud project. Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with the exact same redirect URL used by the Mailbox screen's OAuth callback. Keep the existing mailbox encryption secret stable. Choose Connect Gmail, grant Gmail read/send access and optional Calendar events access. OAuth uses state validation and PKCE; refresh/access tokens are encrypted in storage.

Gmail imports Inbox and Sent messages, resumes paged history, associates accessible contacts/deals, supports threaded replies, and displays sync errors. An expired Gmail history cursor is cleared; sync again to rebuild. Calendar sync handles paged incremental changes and expired sync tokens. Publishing is explicit and sends attendee updates; ETags protect edits from overwriting remote changes. Imported recurring meetings remain managed in Google Calendar. Attachment downloads, Gmail push subscriptions and automatic local-to-provider publishing are not included.

## Deal rooms and DocuSign

Create an expiring customer link (maximum 90 days), add HTTPS documents, frozen proposal PDFs, comments and mutual milestones. The link is a bearer credential: anyone holding it can view shared items and post comments or update milestones. Only the hash is stored. Revoking a room or deleting its deal removes public access. External document links have their own access controls.

Set `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, and `DOCUSIGN_PRIVATE_KEY` (PEM; escaped newlines are accepted). Use `DOCUSIGN_DEMO=true` for the developer environment. Grant the integration JWT signature/impersonation consent in DocuSign. The application derives the API base URI from DocuSign's account profile.

Sending creates a one-signer quote PDF envelope, checks quote approvals, records its quote version and prevents duplicate sends. Check status reconciles sent/delivered/completed states and reports whether the quote has subsequently changed. Completion does not automatically approve an edited quote. An uncertain provider result stays Pending to prevent duplicate envelopes; an administrator must investigate it in DocuSign. Multiple signers, embedded signing, automatic Connect event ingestion and automatic quote acceptance are not included.

## Campaign execution

Queue a message for a campaign's linked contact/lead recipients. The queue snapshots personalized text, deduplicates by campaign/email and checks suppression, current address and current user access before sending. A worker sends up to 25 messages per pass through SMTP. Successful deliveries add FirstTouch influence rows for accessible deals already linked to the contact. Attribution for deals created later requires a subsequent attribution update.

A signed unsubscribe link adds a global suppression and stops matching pending campaign/sequence work. Hard bounces can be received from an SMTP-provider bridge at `/api/public/campaign-bounces`: JSON `{ "type": "hard_bounce", "deliveryId": "..." }`, with `x-campaign-signature: t=UNIX_SECONDS,v1=HEX_HMAC_SHA256`. Sign `timestamp + '.' + rawBody` using a separate `CAMPAIGN_BOUNCE_SECRET`. Provider-specific bounce adapters are not bundled.

Failed and uncertain deliveries are retained for review; they are not automatically resent. SMTP acceptance is not proof of inbox delivery. Open/click tracking and an automated retry UI are not included.

## Account success

Define a playbook with milestone due days and health penalties for overdue milestones, open cases, overdue invoices and stale deals. Enrollment snapshots the definition and creates assigned milestone Activities. Completing or reopening those Activities updates the next evaluation. Hourly evaluation creates one recovery task and notification per new risk episode. The screen also supports manual evaluation. Owners must retain account and metric-module access. Stored health summaries are visible to their owner or an administrator. Scores are transparent rules, not predictive churn models.

## Validation and release

Run the production migration before starting the new server. Provider tests use fixtures: no live Stripe charge, DocuSign delivery, Google OAuth consent or customer SMTP delivery is implied by a passing local test. Configure deployment secrets and perform controlled provider smoke tests before enabling live use. CI remains unchanged.
