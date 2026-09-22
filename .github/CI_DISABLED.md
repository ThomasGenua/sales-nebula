# Continuous integration is intentionally disabled

There are no CI workflows in this repository, and none are registered on
GitHub. This is deliberate: the repository owner disabled GitHub Actions and CI
runners because they were consuming too much of the account's allocation.

Nothing here runs automatically on push or on pull requests. **Every change is
verified locally before it is pushed**, as described below. Do not read a green
pull request as a passing build — there is no build.

## Verifying a change locally

The suite needs PostgreSQL. Point `DATABASE_URL` at a throwaway database, build
its schema from the migrations, and run each suite on its own:

```bash
export DATABASE_URL="postgresql://USER:PASS@127.0.0.1:5432/sales_nebula_test?schema=public"
export NODE_ENV=test JWT_SECRET=local-test-secret

npx prisma migrate deploy          # build the schema exactly as production does
npm test                           # all suites in one process
```

Also run before pushing:

```bash
node scripts/check-prisma-fields.js src     # columns named in code must exist
(cd frontend && npm run build)              # production frontend build
```

`tests/schemaFields.test.js` is a ratchet over the checker's count: it fails if
a change adds a reference to a column that does not exist.

## Re-enabling CI

1. Re-enable Actions in the repository's **Settings → Actions → General**.
2. Add a workflow under `.github/workflows/` that starts a PostgreSQL service,
   sets `DATABASE_URL`, runs `npx prisma migrate deploy`, then `npm test`,
   `node scripts/check-prisma-fields.js src` and the frontend build.
3. Delete this file.
