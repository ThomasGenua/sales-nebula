#!/usr/bin/env node
/**
 * Marketing must not ship route/endpoint inventories in the frontend bundle.
 * This script now writes an empty public stub. Count routes locally if needed
 * for internal docs — never publish them on the website.
 */
const fs = require('fs');
const path = require('path');

const out = `// Intentionally empty of route/endpoint inventories.
// Public marketing must not expose API surface area.
// Internal tooling can count routes from the server source directly.
export const MODULES = [];
export const TOTALS = { modules: 0, models: 0 };
`;

fs.writeFileSync(path.join(__dirname, '..', 'frontend', 'src', 'moduleManifest.js'), out);
console.log('Wrote empty public moduleManifest stub (no endpoint inventory)');
