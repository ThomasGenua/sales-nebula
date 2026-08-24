const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const outputPath = path.join(__dirname, '..', 'prisma', 'schema.sqlite.prisma');

let schema = fs.readFileSync(sourcePath, 'utf8');

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

// SQLite table names are case-insensitive; these are distinct in PostgreSQL.
schema = schema.replace(
  /(model PriceBookEntry \{[\s\S]*?@@index\(\[priceBookId\]\)\r?\n)(\})/,
  '$1  @@map("PriceBookEntryLegacy")\n$2',
);

fs.writeFileSync(outputPath, schema);
console.log(`Generated ${path.relative(process.cwd(), outputPath)}`);
