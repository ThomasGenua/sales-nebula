# Team activation and operational readiness

Apply migrations before starting the release. The new migration adds operational
setup progress, 30-day daily usage, ten-minute OAuth attempts, and signature
event identities. It leaves existing CRM records and approvals unchanged.

## Setup checklist

The checklist is saved per user and can be hidden or reopened. It displays only
steps the role can perform. Pipeline review works with the existing six stages;
administrators can preview and apply flexible or consultative stage requirements.
Applying a template replaces shared requirements and requires the preview's
current version. Teammate invitation, mailbox connection, import and deal steps
reflect actual persisted records. Failed or rolled-back writes cannot complete
the first import/deal/quote milestones. Existing historical work is not backfilled.

The contact CSV template is available at `/templates/contacts.csv`. Remove the
example row, map columns and review the import preview before executing it.

Access Requests → Website conversion, activation & performance reports first
contact import, first deal, first quote and workspace use on two or more UTC days.
It counts distinct accounts linked to measured access requests in the selected
visitor cohort, rather than browser-supplied completion events. The operational
checklist survives analytics opt-out. Opt-out removes daily usage and excludes
milestones from reporting. DNT/GPC and `MARKETING_ANALYTICS_ENABLED=false` prevent
new usage collection. Daily usage and acquisition links expire after 30 days.

## Google and Microsoft browser sign-in

Configure `OAUTH_LOGIN_ENABLED=true` and the provider client ID and secret.
Microsoft also requires `MICROSOFT_TENANT_ID` to be your directory GUID. Register
the exact web redirect `<FRONTEND_URL>/oauth/callback` with both providers.
Only fully configured providers appear on the login screen. This is separate
from connected-app authorization and from mailbox consent.

The browser starts at `POST /api/oauth/start/:provider`. The server stores a
ten-minute state/nonce/PKCE attempt bound to an httpOnly browser cookie. The
callback removes the authorization code from browser history and submits it to
`POST /api/oauth/callback`. The server atomically consumes the attempt, validates
provider identity, and uses normal cookie sessions and the existing MFA gate.
Cancelled, expired or consumed responses require a fresh attempt. It does not
auto-provision users or accept other Microsoft directories. Legacy API exchanges
remain for non-cookie clients; browser sessions must use the protected flow.

Provider references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

## Integration operations

Sales Operations → Integration operations shows administrator setup instructions
and missing setting names, never credential values. Connection checks authenticate
to SMTP, read Stripe API access, or obtain the configured DocuSign account. They
do not send a message, charge, or envelope. A successful check does not prove email
delivery, webhook delivery, or a complete OAuth consent journey.

Optional `<PROVIDER>_CREDENTIAL_EXPIRES_AT` settings (SMTP, GOOGLE, MICROSOFT,
STRIPE, DOCUSIGN) are operator-maintained ISO dates. The screen warns within 14
days. These are not provider-derived expiry dates. Users reconnect their mailboxes
through Mailbox when consent or refresh credentials are revoked.

The recovery queue includes only accessible records. Mail/calendar sync and
payment/signature reconciliation use their existing permission checks. Payment
checks retrieve the existing checkout. Campaign email and uncertain SMTP outcomes
require provider-log review; they are never automatically resent. Webhook history
retains its explicit retry control; receivers must deduplicate retried events.

## Automatic signature status

Set `DOCUSIGN_CONNECT_HMAC_KEY` to your account's Connect HMAC key. An optional
`DOCUSIGN_CONNECT_HMAC_KEY_PREVIOUS` permits rotation. Configure JSON SIM,
envelope data, and sent/delivered/completed/declined/voided events. New envelopes
include a notification destination at `/api/public/docusign/webhook`. Enable
HMAC in DocuSign; scope account-level notifications to this application's
envelopes. Unknown envelope IDs return 409 for retry, including a webhook that
arrives before the envelope-creation response has been saved.

The listener verifies SHA-256 HMAC over original bytes and validates the account
before parsing status. Stable signed event identities deduplicate retries;
timestamps and terminal-state guards prevent regression. Completed, declined and
voided transitions create one notification for the current eligible deal owner.
The sent quote version remains recorded; no event accepts or approves a quote.
Signature event history stores IDs, status and timestamps, not document payloads.

If sending returned an uncertain result, use Deal rooms → Recover existing
envelope. The provider envelope's transaction ID must match the saved request.
If it cannot be verified, recovery refuses and the request remains pending.
Do not send another envelope until the provider outcome is resolved.

References: [DocuSign JSON SIM](https://developers.docusign.com/platform/webhooks/connect/json-sim-event-model/)
and [HMAC verification](https://www.docusign.com/blog/developers/manually-authenticating-hmac-signatures-docusign-connect-webhook-configurations).

## Backup restoration drill

Use a trusted backup and a separate EMPTY database whose name contains
`restore_test`. Point `RESTORE_DATABASE_URL` at it and run:

```text
node scripts/backup.js --local-only
node scripts/restore-check.js path/to/sn-backup-example.sql.gz
```

The checker refuses the source database and nonempty targets, restores with
`psql -X --single-transaction --set ON_ERROR_STOP=1`, then reads CRM counts and
applied migrations. Compare expected fixture counts and run Prisma migrate diff
against the restored schema. The script does not create, drop or overwrite a
database. Keep connection credentials in environment configuration.

CI runs the migration, backend, build and browser gates with cancellation and a
30-minute timeout. See [.github/CI.md](../.github/CI.md). Live provider activation
still requires deployment credentials and controlled provider verification.
