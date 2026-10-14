const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test.each(['\n', '\r\n'])('SQLite generation isolates its client output with %j line endings', newline => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-nebula-schema-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'prisma'));
    const script = path.join(root, 'scripts', 'generate-sqlite-schema.js');
    fs.copyFileSync(path.join(__dirname, '../scripts/generate-sqlite-schema.js'), script);
    const source = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, newline);
    fs.writeFileSync(path.join(root, 'prisma/schema.prisma'), source);
    execFileSync(process.execPath, [script]);
    const generated = fs.readFileSync(path.join(root, 'prisma/schema.sqlite.prisma'), 'utf8');
    expect(generated).toContain('output   = "../src/generated/sqlite-client"');
    expect(generated).toContain('provider = "sqlite"');
    expect(generated).toContain('env("SQLITE_DATABASE_URL")');
    expect(generated).toMatch(/actionsRun\s+Json/);
    expect(fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8')).toBe(source);
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('sales-nebula-schema-')) {
      throw new Error('Refusing to remove a path outside the schema test temporary directory');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
