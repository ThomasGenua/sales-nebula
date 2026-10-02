# Sales pilot setup and workflows

## Current feature availability

- **Campaigns:** planning, recipient lists and response tracking are available.
  Bulk campaign delivery is unavailable; the send API returns 501 without
  changing campaign or recipient delivery state. Use the individual sales-email
  workflow for messages when SMTP is configured.
- **Generic integrations:** configuration, mappings and schedule settings can be
  stored, but sync and connection tests return 501. Saving a schedule does not
  start a sync worker. This does not disable the separate Microsoft mailbox
  APIs, outbound webhooks or Connected Apps.
- **Sign-in:** use password sign-in and optional authenticator-app MFA in the
  browser. Generic SAML/OIDC configuration does not enable sign-in; that login
  endpoint returns 501. SMS/email MFA is unavailable. The separate Google and
  Microsoft sign-in APIs require explicit provider configuration and an existing
  active account; the browser has no provider buttons or OAuth callback flow.

## First production install

Copy `.env.example` to `.env`. Set `POSTGRES_PASSWORD` to a unique database
password, `JWT_SECRET` to at least 32 random characters, and
`INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` to your first administrator's
credentials. The administrator password needs at least 12 characters,
uppercase and lowercase letters, a number and a special character, and at most
72 UTF-8 bytes. Set `FRONTEND_URL` to the public HTTPS origin and configure SMTP
for invitations, password resets and sales email.

Run `docker compose up --build -d`. PostgreSQL and Redis are reachable only
inside the Compose network. The API waits for migrations and administrator
creation to succeed. Missing bootstrap credentials on a fresh database stop
startup with a useful message; no demo accounts or customer records are seeded.

Sign in at `/login`. After the first successful start, remove
`INITIAL_ADMIN_PASSWORD` from `.env` and recreate the migration container on the
next deployment. Bootstrap skips installations that already have users and
never resets their passwords. For a local production installation, set
`DATABASE_URL` as well and run `npm run setup:prod` before `npm start`.

Demo data remains available through `npm run db:seed` in development. An isolated
production demo requires `ALLOW_DEMO_SEED=true`; do not use that setting for a
customer installation. The browser demo still runs without a database.

This is a single-company CRM. Give each hosted customer a separate deployment,
database and file storage location. Inviting an account grants access within
that company; it does not create a separate tenant.

## Daily sales workflow

1. Open a lead and choose **Convert lead**. A contact is always created. Choose
   whether to create an account from the company and a deal with its value and
   close date. Links open the resulting records. Conversion is atomic and a
   repeated request cannot create a second set of records.
2. Open a contact or deal and choose **Compose email**. Check the recipient,
   enter the subject and message, then send. You can also send a saved draft
   from its Emails detail screen. Delivery success, rejection and missing SMTP
   configuration have distinct messages. Failed attempts remain retryable.
3. Create or edit a quote. Search for the account, contact and deal to link it,
   then add products with quantity, unit price and any discount. Each discount
   is an amount, not a percentage. The quote discount comes off the line
   subtotal; tax is added afterwards. Totals update while editing.
4. Open the quote to preview its document and use **Print / Save as PDF**.
   Choose **Record acceptance** when the customer has agreed. This records the
   acceptance; it is not an electronic signature.
5. Choose **Create invoice** and open the result. Its amounts and product lines
   come from the quote. A second request is refused by the API, naming the
   invoice that already exists. Related-record links let you move between the
   invoice, quote, contact and account.

Conversion requires lead and contact edit permission, plus account/deal edit
permission for the optional records. Sending requires email edit permission;
quote acceptance requires quote edit permission; invoice creation requires
invoice edit permission. Demo sessions and read-only users have no mutation
actions on these screens.

## Local release verification

Install the root and frontend dependencies with `npm ci` in each directory and
install Chromium with `npx playwright install chromium`. Create two empty
throwaway PostgreSQL databases with `test` in their names. Set `DATABASE_URL`
for the test suite and `MIGRATE_URL` for the separate migration check. Then run:

```sh
npm run verify
```

The command checks production migrations and schema drift, applies migrations
to the test database, runs the schema checker and all Jest suites, builds the
frontend, and runs Chromium against a real API and PostgreSQL. Browser tests
use a local SMTP server to capture messages and deliberately reject a delivery;
they never send customer mail. Ports 7545 and 2526 must be available.
Webhook tests use controlled DNS responses and need no public DNS service.

Tests erase their test database. The existing database-name guard applies to
both URLs. GitHub Actions remains disabled; this gate runs locally. Browser
failures retain screenshots and traces in `test-results/`.

## Backup and restore drill

The production image includes the PostgreSQL client and backup script. Run
`docker compose exec api node scripts/backup.js` to create a compressed SQL
backup. Copy it out with `docker compose cp api:/app/backups/<file>.sql.gz ./`.
Uploads are stored separately in the `uploads_data` volume and need their own
backup. Store backups outside the application host; `--upload-s3` supports the
existing S3 backup configuration.

Restore into a new empty PostgreSQL database using a client compatible with
the database version. Decompress the SQL and run it through
`psql --set ON_ERROR_STOP=1` with the destination connection. Verify user counts,
quote and invoice totals, and a sign-in against the restored database before
relying on the backup. A dump process failure now exits nonzero and removes the
partial archive, even if compression itself succeeds.

For existing Docker installations, set `POSTGRES_PASSWORD` to the password
already stored in PostgreSQL. Changing the environment does not rotate an
existing database user's password. Remove any demo accounts through normal
user management after confirming another administrator can sign in.
