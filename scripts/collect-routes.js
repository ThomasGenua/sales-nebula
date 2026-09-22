/**
 * Every GET route the API mounts, found by reading the source.
 *
 * The static field checker can only see column names in literal Prisma calls.
 * This complements it at runtime: tests/endpointSmoke.test.js calls each of
 * these routes as an administrator and fails on any 5xx, which catches the
 * faults a static read cannot — a handler that dereferences a record that was
 * not found, a missing `await`, a column assembled at runtime.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** mount path -> route files, from each `app.use('/api/…', …require('./routes/…'))`. */
function collectMounts(appSource) {
  const mounts = [];
  for (const chunk of appSource.split('app.use(').slice(1)) {
    const at = chunk.match(/^\s*'(\/api\/[^']+)'/);
    if (!at) continue;
    // Only look inside this one call, not into the next app.use.
    const body = chunk.slice(0, chunk.indexOf(';') + 1 || undefined);
    const req = body.match(/require\('\.\/routes\/([^']+)'\)/);
    if (req) mounts.push({ mount: at[1], file: `src/routes/${req[1].replace(/\.js$/, '')}.js` });
  }
  return mounts;
}

/** The GET paths a router file declares, with the line each is on. */
function collectGets(source) {
  const routes = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/router\.get\(\s*(['"`])([^'"`]+)\1/g)) {
      routes.push({ path: m[2], line: i + 1 });
    }
  });
  // A router built by the shared CRUD factory has its list and read routes.
  if (/createCrudRouter\(/.test(source)) {
    routes.push({ path: '/', line: 0, crud: true }, { path: '/:id', line: 0, crud: true });
  }
  return routes;
}

// Values for path parameters. An id that matches nothing must produce a 404,
// never a 500, so ids get a well-formed UUID that no row will have.
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const PARAM_VALUES = {
  module: 'contacts', parentModule: 'contacts', entity: 'contacts', objectType: 'contacts',
  format: 'csv', type: 'contacts', provider: 'microsoft', period: 'month', mode: 'month',
  year: '2026', month: '9', token: 'invalid-token', key: 'missing', slug: 'missing', name: 'missing',
};

function fillPath(route) {
  return route.replace(/:([A-Za-z_]+)\??/g, (_, name) => PARAM_VALUES[name] || MISSING_ID);
}

function collectGetRoutes() {
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const out = [];
  const seen = new Set();
  for (const { mount, file } of collectMounts(appSource)) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    for (const r of collectGets(fs.readFileSync(full, 'utf8'))) {
      const url = (mount + (r.path === '/' ? '' : r.path)).replace(/\/+$/, '') || mount;
      const key = `${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ mount, file, line: r.line, route: url, url: fillPath(url) });
    }
  }
  return out;
}

module.exports = { collectGetRoutes, collectMounts, collectGets, fillPath, MISSING_ID };
