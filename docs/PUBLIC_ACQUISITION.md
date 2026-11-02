# Public site and access journey

The public website includes `/`, `/hosting`, and `/tour`. `/demo` immediately opens the browser-only sample workspace and a three-step lead → deal → quote tour. Demo API calls use local fictional records; writes are refused. Leaving the demo for `/login`, or accepting a real invitation, clears demo mode so it does not hide the real workspace.

The hosting page distinguishes self-hosting from hosting by arrangement. It intentionally publishes no invented price, support SLA, or provisioning commitment. Agree on those details before activating a managed installation.

## Build and deployment

1. Install frontend dependencies with `npm --prefix frontend ci`.
2. Set `VITE_PUBLIC_SITE_URL` in the build environment (or `frontend/.env.local`) to the public origin. The default is `https://salesnebula.com`. Docker accepts the same build argument. Setting it only in the backend runtime does not rebuild metadata.
3. Run `npm --prefix frontend run build`. Vite builds the client, then prerenders home, hosting, walkthrough, privacy, and terms pages. The build writes route-specific metadata, `sitemap.xml`, `robots.txt`, and a separate empty `app.html` shell.
4. Run `npm run prisma:generate` and `npm run db:migrate:prod` before starting the updated backend. Migration `20261102000000_public_acquisition` adds measurements and request attribution fields. SQLite deployments use the generated schema and their existing `db:push:sqlite` process.
5. Configure `FRONTEND_URL` and SMTP as described in the deployment documentation. When `FRONTEND_URL` lists several allowed origins, its first origin is used in emails. Real verification, status recovery, and invitation delivery require working transactional mail.

Express serves prerendered public HTML and the app shell for private routes. Private routes receive `X-Robots-Tag: noindex, nofollow`; unknown routes return 404. JavaScript hydrates public pages without downloading the CRM module until needed. The existing CSP continues to hash the shared theme script.

## Request follow-through

- A successful request offers resend verification and a link to `/access-status`.
- Verification returns a separate status proof, stored in tab session storage. The status proof cannot authenticate a workspace session.
- A visitor without the proof can request an emailed link. The response is the same for known and unknown addresses, including SMTP delivery failures.
- Emailed proofs expire after seven days and travel in the URL fragment. The page removes that fragment and submits the proof in a POST body; it is not sent in a referring URL or query string.
- Status shows pending verification, review, invitation, rejection, or account creation and gives appropriate next steps. It never exposes internal review notes, invitation tokens, or other requests. An expired invitation directs the visitor to the inviting administrator.

## Conversion and performance measurement

Open **Access requests → Website conversion & performance** as a user with `users:read` permission. Choose a 7, 14, or 30-day visitor cohort. The view includes visits, demos started, tours finished, forms started, access requests, verified emails, and first sign-ins, plus campaign source groups and p75 LCP, INP, and CLS with sample counts.

Sessions use a random UUID kept in tab session storage for up to 30 minutes. Campaign codes (`utm_source`, `utm_medium`, `utm_campaign`) are limited to 80 alphanumeric, dot, underscore, or hyphen characters. No full referrer URLs, IP addresses, emails, or user agents are stored in the measurement table. A submitted request links the visit to server-recorded verification and invitation acceptance; the browser cannot submit those conversion milestones. Demo and form events are optional steps, so their counts are not a mandatory linear funnel.

The report is bounded to the latest 10,000 measured visits and labels that limit when reached. It excludes visitors who opt out, blocked measurement requests, and requests that cannot be linked to a recorded visit. These figures are directional, not billing records or bot-filtered traffic counts. Sparse performance samples are not a passing Core Web Vitals verdict. Metrics describe the initial public landing document; route changes are not treated as new navigation measurements.

Visitors can disable collection on the Privacy page. Do Not Track and Global Privacy Control also disable it. Set `MARKETING_ANALYTICS_ENABLED=false` at runtime to disable collection across an installation. Existing session measurements and request links are deleted after 30 days by the daily event-log cleanup and opportunistic hourly cleanup during collection/reporting; campaign codes remain with the request. Operational and security logs are separate.

## Product screenshots and verification

`node scripts/capture-product.js` starts a temporary local static server, opens only the browser sample workspace, and captures the actual lead, deal, and quote views into `frontend/public/product/`. It also updates the local build's copies. The images contain fictional records and sample amounts, not customer data or Sales Nebula pricing. Rebuild before capture when changing product UI; future production builds copy the checked-in screenshots.

`npm run test:landing` builds and tests public pages without a database or real email. API calls are mocked; it covers the guided demo, attribution, resend/status links, privacy controls, prerendered pages, metadata, images, keyboard behavior, and narrow layouts.

Backend regression coverage: `tests/publicAcquisition.test.js`, `tests/accessRequests.test.js`, and `tests/signup.test.js`. Use a disposable test database: the test harness clears its tables. SMTP is mocked for the new acquisition tests.
