const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const outputPath = path.join(__dirname, '..', 'prisma', 'schema.sqlite.prisma');

// Normalize Windows checkouts before matching schema blocks. Otherwise the
// SQLite generation can retain PostgreSQL's default client output and overwrite it.
let schema = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

schema = schema.replace(
  'generator client {\n  provider = "prisma-client-js"\n}',
  'generator client {\n  provider = "prisma-client-js"\n  output   = "../src/generated/sqlite-client"\n}',
);

schema = schema.replace(
  'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}',
  'datasource db {\n  provider = "sqlite"\n  url      = env("SQLITE_DATABASE_URL")\n}',
);

// SQLite has no scalar-list columns. JSON preserves the API's array shape.
schema = schema.replace(
  /^([ \t]+\w+[ \t]+)String\[\]([ \t]*)(?:@default\((\[[^\n)]*\])\))?([^\n]*)$/gm,
  (_line, prefix, spacing, defaultValue = '[]', suffix) => {
    const escapedDefault = defaultValue.replace(/"/g, '\\"');
    return `${prefix}Json${spacing || ' '}@default("${escapedDefault}")${suffix}`;
  },
);

if (!schema.includes('output   = "../src/generated/sqlite-client"') || !schema.includes('provider = "sqlite"')) {
  throw new Error('SQLite schema generation did not replace the client output and datasource blocks');
}
fs.writeFileSync(outputPath, schema);
console.log(`Generated ${path.relative(process.cwd(), outputPath)}`);
