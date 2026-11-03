# Sales completion

This release adds five operational workflows to the existing CRM. Apply production migrations and build the frontend before starting the application. Node 20.19 or newer is required for the enterprise JWT library; CI uses the current Node 20 release. The existing minute scheduler processes push notifications, migrations, meeting jobs and billing reconciliation. Persistent PostgreSQL is required.

## Mailbox attachments and push

In **Inbox → Connections**, enable live updates after connecting a personal Outlook or Gmail account. Polling continues as a fallback. Notifications schedule a sync using the existing cursor; a renewed watch never replaces that cursor with the provider's newest position. Notifications do not directly trust message contents.

In a message, **View attachments** lists file attachments and **Download** fetches their content from the connected provider. Downloads require access to that specific personal mailbox, are served as attachments with no caching, and are limited to 20 MiB. Larger files and cloud reference attachments must be opened in the email provider. Gmail inline file bodies are supported.

- Microsoft: configure a public HTTPS `FRONTEND_URL`. The webhook is `/api/public/mail-notifications/microsoft`; it accepts the provider's validation challenge and verifies each subscription's client state. Subscriptions renew daily with a two-day expiry. Removed subscriptions are recreated, and lifecycle notifications trigger renewal and catch-up polling. The delegated mailbox connection needs its existing mail permissions.
- Gmail: set `GOOGLE_PUBSUB_TOPIC` to `projects/PROJECT/topics/TOPIC`. Grant `gmail-api-push@system.gserviceaccount.com` permission to publish to that topic. Create an authenticated push subscription targeting `/api/public/mail-notifications/google`. Set `GOOGLE_PUBSUB_AUDIENCE` to that subscription's configured audience and `GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL` to its push identity. Google-signed ID tokens, audience, email and verification state are checked. Watches renew daily.
- Failed renewals and syncs are retried after five minutes and shown on the connection. Disconnecting the mailbox stops accepting pushes before clearing credentials. Remote cleanup failures expire at the provider.

References: [Gmail push setup](https://developers.google.com/workspace/gmail/api/guides/push), [Graph lifecycle notifications](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events).

## Salesforce and HubSpot migration

Open **Sales Operations → CRM migration** with administrative access. Export CSVs from the source CRM; this is a guided CSV migration, not a remote Salesforce/HubSpot API connector.

1. Choose the source and a stable source-organization name. Reuse that exact name for later exports from the same CRM.
2. Upload accounts/companies, contacts, leads and deals/opportunities. Map source record IDs, columns and relationship IDs. Import accounts before people and deals; the wizard orders files accordingly. Linked parents may also come from an earlier migration for that organization.
3. Map owner IDs to active team email addresses with a `sourceId,email` CSV, or map an owner-email column. New records without owner information belong to the importing administrator; updates without owner information preserve the existing owner.
4. Map custom source stage labels to the supported CRM stages. Review invalid rows, edit mappings or correct individual preview rows. Unknown owners, missing parents, invalid values and ambiguous duplicate matches remain visible errors.
5. Acknowledge active automation and start. The worker saves each row and its external-ID link atomically. Resume retries failed rows without repeating applied rows. Pause stops after the current record.

Matching uses the saved external ID first, then email for people or name for accounts/deals. Choose to preserve matching records or update their mapped fields. Blank mapped values are deliberate values on update. Migrations run the normal record validation, permissions, audit and workflow path.

**Undo** previews all applied rows, verifies a hash and record versions, and refuses records changed since import or records with new dependencies. A successful undo restores prior mapped values and soft-deletes records created by that migration in one transaction. Messages and other external automation effects cannot be recalled. Large undo transactions can time out and roll back; split very large exports into smaller migrations when independent undo is important.

Limits: 50,000 rows and 19 MiB combined request data; 12 MiB per selected CSV. The supported fields are shown by the mapping screen. Activities, attachments, custom fields, source automation, permission models and arbitrary many-to-many associations are not migrated by this wizard. Export each primary relationship as one source ID. Existing general CSV import remains available for custom-field mapping.

## Meetings into reviewed CRM changes

Open **Sales Operations → Meeting intelligence**. Set `DEEPGRAM_API_KEY` for audio transcription and the existing `ANTHROPIC_API_KEY` / optional `ANTHROPIC_MODEL` for summaries. A transcript can be pasted without a Deepgram key. Audio uses Deepgram Nova-3 with speaker diarization and timed utterances; Claude receives the transcript as untrusted text and produces a validated draft.

- Upload MP3, WAV, M4A, Ogg, FLAC or WebM, up to 100 MiB, or paste up to 150,000 transcript characters. Recording headers are checked. Confirm permission to record and process the meeting.
- Audio is private under `UPLOAD_DIR/meeting-audio`. Use persistent local storage on the application instance; uploads and the scheduler must share it. Successful transcription removes audio. Failed retained audio and abandoned uploads expire after 24 hours.
- A draft does not create CRM records. Review and edit task subjects/dates and the linked deal's next step/date, then select exactly what to apply. Selected tasks belong to the reviewer. No automated stage, amount, owner or forecast changes are proposed.
- Applying is transactional and one-use. A later change to the linked deal requires a regenerated draft before a next-step update. Failed analysis retains the transcript for retry; interrupted provider requests require explicit retry and can incur another provider charge.
- Recordings belong to their uploader; administrators can manage them. Links are checked at upload, processing and apply time. Deleting a meeting removes its transcript and draft but preserves already-applied CRM changes.
- Privacy export includes linked meeting drafts and migration snapshots. Erasure prevents migration undo from restoring personal data; purge removes linked meeting transcript/draft/audio. An in-progress migration or meeting must finish or be paused before erasure can acquire its processing lock.

The prior keyword-analysis endpoint remains available for existing recordings. This feature does not join meetings automatically or record calls.

## Enterprise identity

Open **Sales Operations → Enterprise configuration** for safe setup status and callback URLs. Secrets remain in deployment environment variables. The app supports one configured issuer per protocol per installation, with existing active staff accounts; it does not create accounts from arbitrary sign-in claims.

Set `ENTERPRISE_SSO_ENABLED=true` and `ENTERPRISE_EMAIL_DOMAINS` to a comma-separated allowlist. Configure an HTTPS `FRONTEND_URL` in production.

### OIDC (Entra/Okta)

Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL` and `OIDC_JWKS_URL` from the identity provider's application configuration. These are operator-pinned HTTPS endpoints. Register the exact redirect URI `FRONTEND_URL/oauth/callback?enterprise=oidc` and use authorization code flow with a confidential web client. The token request uses `client_secret_post` authentication. Scopes are `openid profile email`.

The code exchange uses PKCE; signed ID tokens must pass issuer, audience, algorithm (RS256/ES256), expiry, age, subject, nonce and authorized-party checks. First-time linking requires a verified email or a user provisioned through SCIM. This accommodates Entra tenants that omit `email_verified` without trusting an unverified email for a local account. Later logins use the immutable issuer/subject binding rather than a changed email claim.

### SAML

Set `SAML_ENTRY_POINT`, `SAML_IDP_ISSUER` and `SAML_IDP_CERT`. Optionally set `SAML_SP_ENTITY_ID` (defaults to the metadata URL) and `SAML_SP_PRIVATE_KEY`/`SAML_SP_CERT` for signed AuthnRequests. PEM environment values accept literal `\n` or multiline values.

- Reply/ACS URL: `FRONTEND_URL/api/enterprise/saml/acs`.
- Metadata: `FRONTEND_URL/api/enterprise/saml/metadata`.
- Require the IdP to sign **both assertion and response**. In Entra select the corresponding signing option; in Okta enable both signature settings.
- Send a stable persistent NameID and `email`/`mail`, the standard email-address claim URI, or the standard email OID attribute. Assertions must identify the configured issuer and audience and match an outstanding AuthnRequest. IdP-initiated unsolicited assertions are rejected.
- Request IDs and assertion IDs use database-backed replay protection. The cross-site ACS response exchanges into a short-lived one-use ticket; completing login requires the original browser's HTTP-only cookie. Existing local MFA still applies.

Test sign-in before setting `ENTERPRISE_SSO_REQUIRED=true`. This enforces enterprise sign-in for new staff login attempts; existing sessions are not automatically revoked by changing the environment. Set `ENTERPRISE_BREAK_GLASS_EMAILS` to designated recovery accounts and verify their password/MFA access. Portal sign-in is independent. The old `/api/security/sso` configuration records remain preserved but do not activate these deployment-managed providers; the legacy direct-token login endpoint remains disabled.

### SCIM users

Set a random `SCIM_BEARER_TOKEN` of at least 32 characters and `SCIM_DEFAULT_ROLE` to an existing role without administrative or user/role management privileges. Configure Entra/Okta SCIM at `FRONTEND_URL/api/scim/v2` with that bearer token.

Supported: user discovery, pagination, `userName eq "email"` / `externalId eq "id"` filters, creation, PUT, PATCH, `active` updates and DELETE; ServiceProviderConfig, ResourceTypes and Schemas discovery. User names and primary emails must match. Core name and email paths are supported. Group provisioning, role mapping, bulk operations, password sync, sorting and ETags are not advertised. Existing local accounts are not silently adopted; provision new users or use existing staff with verified sign-in email claims.

Deactivation increments a persistent session version, revokes API keys and connected-app grants, disconnects local sockets and disables mailbox connections. Reactivation does not revive old tokens or mailbox consent. Administrative accounts cannot be changed through SCIM. `active=false` is the reversible suspension mechanism. DELETE deactivates and removes the user from SCIM lookup while retaining CRM history and reserving its email; recovery of a deleted identity requires administrator intervention. Audit logs record provisioning changes without credentials.

## Credits, refunds, disputes and reconciliation

Open **Sales Operations → Payments**, choose an invoice, then use **Credits, refunds and disputes**. Credit notes and refunds have a review step, mandatory reason, amount bounds and persistent request IDs. Only users with edit access to that invoice can create them.

- A credit note reduces the original invoice amount. It creates an immutable adjustment and downloadable PDF; it does not return money. These are local invoice credits, since Sales Nebula invoices use Stripe Checkout rather than Stripe Billing invoices.
- A refund returns a selected Stripe receipt. Its reservation is committed before contacting Stripe and the provider request is idempotent. Pending/succeeded refunds and disputed funds reduce the amount available to refund. A network timeout keeps the reservation until provider reconciliation; retries of the same application request do not send another refund.
- **Reconcile Stripe ledger** reads refunds and disputes for known PaymentIntents, including events created directly in Stripe. Legacy Checkout receipts are verified against their original session before binding a PaymentIntent. Unknown unrelated Stripe activity is ignored.
- Subscribe the existing signed webhook `/api/public/stripe/webhook` to `refund.created`, `refund.updated`, `refund.failed`, and `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed` (plus existing Checkout completion events). Every update retrieves the current provider object under a lease, so replayed/out-of-order callbacks cannot apply an old payload over a newer status.
- Open disputes and lost disputes reduce net received funds; a win restores them without creating a second receipt. Inquiry/warning states do not subtract funds. Evidence deadlines are displayed; submit evidence through Stripe. The invoice ledger tracks principal, not processor fees or bank payouts.
- Balance = original invoice less issued credit notes, compared with receipts less successful refunds and open/lost disputed principal, floored per receipt. Gross receipts remain immutable. Pending refunds and active disputes suppress automatic overdue reminders and new Checkout creation.
- Provider facts remain recorded even if an invoice validation rule prevents its display status updating; the adjustment shows the recovery error and the calculated ledger stays accurate. Resolve the rule and reconcile again.

An unresolved refund with no provider object remains reserved and visible. Verify it in Stripe before creating a separate refund; the worker never guesses that an uncertain money movement failed. Stripe keys and webhook secrets are required for live activation. Local tests use generated identities and provider fixtures and perform no live money movement.
