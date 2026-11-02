# Continuous integration

CI verifies migrations on a fresh PostgreSQL database, checks schema references,
runs backend tests, builds the frontend and prerendered pages, and runs public
and authenticated browser journeys. It uses disposable service credentials.

One job runs per pull request or main push. New commits cancel older runs for
the same ref; each run has a 30-minute limit. Browser failure artifacts expire
after seven days. Repository Settings → Actions must allow workflows.

For local verification, use `npm run verify` with separate throwaway
`DATABASE_URL` and `MIGRATE_URL` databases. See `docs/SALES_PILOT.md`.
