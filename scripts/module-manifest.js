#!/usr/bin/env node
/**
 * Regenerate frontend/src/moduleManifest.js from the live route table.
 * The landing page quotes real endpoint counts, so this keeps the marketing
 * claims honest as the API grows. Run after adding or removing routes.
 */
const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '..', 'src', 'routes');
const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');

const rows = [];
for (const file of fs.readdirSync(routesDir).filter(f => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
  const count = (src.match(/^router\.(get|post|put|patch|delete)/gm) || []).length;
  if (count > 0) rows.push([file.replace('.js', ''), count]);
}
rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const models = (fs.readFileSync(schemaPath, 'utf8').match(/^model /gm) || []).length;
const literal = rows.map(r => `["${r[0]}",${r[1]}]`).join(',');

const out = `// Generated from the live route table. Every count is real.
// Regenerate: node scripts/module-manifest.js
export const MODULES = [${literal}];

export const TOTALS = {
  modules: MODULES.length,
  endpoints: MODULES.reduce((s, m) => s + m[1], 0),
  models: ${models},
};
`;

fs.writeFileSync(path.join(__dirname, '..', 'frontend', 'src', 'moduleManifest.js'), out);
console.log(`Wrote ${rows.length} modules, ${rows.reduce((s, r) => s + r[1], 0)} endpoints, ${models} models`);
