/**
 * Every field name a Prisma call uses must exist on the model.
 *
 * Large parts of this codebase were written against a schema that was imagined
 * rather than migrated: `Note.parentId` where the column is `recordId`,
 * `AuditLog.timestamp` where it is `createdAt`, `deletedAt` on models with no
 * soft delete. Prisma rejects an unknown argument, so each one is a guaranteed
 * 500 — or, inside a `.catch(() => [])`, a silently empty list. No test caught
 * any of them because no test calls those endpoints.
 *
 * This started as a ratchet over a backlog of 444 such references. The backlog
 * is cleared, so it is now a gate: the application code, the seed script and
 * the maintenance scripts must name only columns and relations that exist.
 */

const path = require('path');
const { checkPaths } = require('../scripts/check-prisma-fields');

const root = path.join(__dirname, '..');
let findings;

beforeAll(() => {
  findings = checkPaths(['src', 'prisma/seed.js', 'scripts'].map(p => path.join(root, p)));
});

describe('Prisma field references', () => {
  it('never names a column or relation that does not exist', () => {
    // Listed rather than counted, so a failure says exactly what to fix.
    expect(findings.map(f => `${f.file}:${f.line} ${f.model}.${f.key} [${f.where}]`)).toEqual([]);
  });
});

describe('The checker itself', () => {
  const { Prisma } = require('@prisma/client');
  const fs = require('fs');
  const os = require('os');

  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldcheck-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = code => {
    const file = path.join(dir, `case-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, code);
    return file;
  };

  it('flags a column the model does not have', () => {
    const found = checkPaths([write('prisma.contact.findMany({ where: { nonsense: 1 } });')]);
    expect(found.map(f => `${f.model}.${f.key}`)).toEqual(['Contact.nonsense']);
  });

  it('accepts a column it does have', () => {
    expect(checkPaths([write('prisma.contact.findMany({ where: { email: "a@b.c" } });')])).toEqual([]);
  });

  it('follows a relation into a nested include', () => {
    const found = checkPaths([write('prisma.deal.findMany({ include: { contact: { select: { nope: true } } } });')]);
    expect(found.map(f => `${f.model}.${f.key}`)).toEqual(['Contact.nope']);
  });

  it('recurses through AND/OR rather than treating them as columns', () => {
    const found = checkPaths([write('prisma.contact.findMany({ where: { OR: [{ email: "x" }, { bogus: 1 }] } });')]);
    expect(found.map(f => `${f.model}.${f.key}`)).toEqual(['Contact.bogus']);
  });

  it('allows a compound unique selector, which is not a column', () => {
    const compound = Prisma.dmmf.datamodel.models
      .find(m => (m.uniqueFields || []).some(u => u.length > 1));
    // Skip rather than assert nothing if the schema has no compound unique.
    if (!compound) return;
    const key = compound.uniqueFields.find(u => u.length > 1).join('_');
    const delegate = compound.name.charAt(0).toLowerCase() + compound.name.slice(1);
    expect(checkPaths([write(`prisma.${delegate}.findUnique({ where: { ${key}: {} } });`)])).toEqual([]);
  });

  it('checks both sides of an upsert', () => {
    const found = checkPaths([write('prisma.contact.upsert({ where: { id: "1" }, create: { firstName: "A", lastName: "B", bad1: 1 }, update: { bad2: 2 } });')]);
    expect(found.map(f => f.key).sort()).toEqual(['bad1', 'bad2']);
  });

  it('reports a create that omits a required column', () => {
    // How the seed script's DealLineItem.name and the inbound-mail Lead.company
    // faults both read: nothing unknown, just something absent.
    const found = checkPaths([write('prisma.contact.create({ data: { email: "a@b.c" } });')]);
    expect(found.map(f => `${f.key}:${f.where}`).sort())
      .toEqual(['firstName:missing-required', 'lastName:missing-required']);
  });

  it('does not demand a key the parent relation supplies', () => {
    const found = checkPaths([write(
      'prisma.role.create({ data: { name: "R", permissions: { create: [{ module: "m", level: "full" }] } } });')]);
    expect(found).toEqual([]);
  });

  it('says nothing about a create whose data is spread from a variable', () => {
    const found = checkPaths([write('prisma.contact.create({ data: { ...payload } });')]);
    expect(found).toEqual([]);
  });

  it('ignores calls on things that are not Prisma models', () => {
    expect(checkPaths([write('cache.somethingElse.findMany({ where: { whatever: 1 } });')])).toEqual([]);
  });
});
