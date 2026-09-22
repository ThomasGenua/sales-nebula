/**
 * Static check: every field name a Prisma call names must exist on the model.
 *
 * Routes here were written against a schema that was imagined rather than
 * migrated — `Note.parentId` where the column is `recordId`, `AuditLog.timestamp`
 * where it is `createdAt`, `deletedAt` on models that have no soft delete. Prisma
 * rejects an unknown argument at runtime, so each one is a guaranteed 500 (or,
 * inside a `.catch(() => [])`, a silently empty list) that no test covers because
 * no test calls the endpoint.
 *
 * This walks the AST of every backend source file, finds calls on a Prisma model
 * delegate, and checks the field names in `data`, `where`, `select`, `include`
 * and `orderBy` against the generated datamodel. Run it directly for a report:
 *
 *   node scripts/check-prisma-fields.js src
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const { Prisma } = require('@prisma/client');

const MODELS = new Map();           // delegate name -> model
const BY_NAME = new Map();          // model name -> model
for (const m of Prisma.dmmf.datamodel.models) {
  MODELS.set(m.name.charAt(0).toLowerCase() + m.name.slice(1), m);
  BY_NAME.set(m.name, m);
}

const READ_OPS = new Set(['findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const WRITE_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const OPS = new Set([...READ_OPS, ...WRITE_OPS]);

// Filter/aggregate keys that are never model fields.
const LOGICAL = new Set(['AND', 'OR', 'NOT']);
const AGG = new Set(['_count', '_sum', '_avg', '_min', '_max', '_all', '_relevance']);

function fieldNames(model) {
  const names = new Set(model.fields.map(f => f.name));
  // Compound unique selectors are addressable as joined names or index names.
  for (const u of model.uniqueFields || []) names.add(u.join('_'));
  for (const idx of model.uniqueIndexes || []) {
    if (idx.name) names.add(idx.name);
    if (idx.fields) names.add(idx.fields.join('_'));
  }
  if (model.primaryKey?.fields) names.add(model.primaryKey.fields.join('_'));
  return names;
}

/**
 * Scalars a `create` must supply: required, no default, not @updatedAt. A
 * required foreign key counts as supplied if the relation is written instead
 * (`deal: { connect }` in place of `dealId`).
 */
function requiredForCreate(model) {
  const viaRelation = new Map();
  for (const f of model.fields) {
    if (f.kind !== 'object' || !f.relationFromFields) continue;
    for (const from of f.relationFromFields) viaRelation.set(from, f.name);
  }
  return model.fields
    .filter(f => f.kind === 'scalar' && f.isRequired && !f.hasDefaultValue && !f.isUpdatedAt && !f.isId)
    .map(f => ({ name: f.name, relation: viaRelation.get(f.name) || null }));
}

const EMPTY = new Set();

const relationTarget = (model, key) => {
  const f = model.fields.find(x => x.name === key);
  return f && f.kind === 'object' ? BY_NAME.get(f.type) : null;
};

const findings = [];
const record = (file, line, model, key, where) =>
  findings.push({ file, line, model: model.name, key, where });

function keysOf(node) {
  if (!node || node.type !== 'ObjectExpression') return [];
  return node.properties
    .filter(p => p.type === 'ObjectProperty' && !p.computed)
    .map(p => ({
      name: p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null,
      value: p.value,
      line: p.loc?.start.line,
    }))
    .filter(k => k.name);
}

const prop = (node, name) => keysOf(node).find(k => k.name === name)?.value || null;

// Nested relation writes: { posts: { create: {...}, connect: {...} } }.
const NESTED_WRITE = new Set(['create', 'createMany', 'connectOrCreate', 'update', 'updateMany', 'upsert']);
const NESTED_WHERE = new Set(['connect', 'disconnect', 'delete', 'deleteMany', 'set']);

/** data / update / create payloads: top-level keys must be fields. */
function checkData(file, model, node, label, creating = false, implied = EMPTY) {
  if (!node) return;
  if (node.type === 'ArrayExpression') {
    for (const el of node.elements) checkData(file, model, el, label, creating, implied);
    return;
  }
  if (node.type !== 'ObjectExpression') return;

  // A create that names a required column nowhere is as broken as one that
  // names a column that does not exist; Prisma rejects both. A spread could
  // supply anything, so an object containing one is not judged.
  const spread = node.properties.some(pr => pr.type === 'SpreadElement');
  if (creating && !spread) {
    const present = new Set(keysOf(node).map(k => k.name));
    for (const req of requiredForCreate(model)) {
      if (present.has(req.name)) continue;
      if (req.relation && present.has(req.relation)) continue;
      // Written through a parent's relation, so Prisma supplies the key.
      if (implied.has(req.name)) continue;
      record(file, node.loc?.start.line, model, req.name, 'missing-required');
    }
  }

  const names = fieldNames(model);
  for (const k of keysOf(node)) {
    if (!names.has(k.name)) { record(file, k.line, model, k.name, label); continue; }
    // A relation's payload is checked against the *related* model, which is
    // where a seed script's nested `create: [...]` hides its bad columns.
    const relField = model.fields.find(f => f.name === k.name && f.kind === 'object');
    const target = relationTarget(model, k.name);
    if (target && relField) checkNestedRelation(file, target, relField, k.value, label);
  }
}

function checkNestedRelation(file, target, relField, node, label) {
  if (!node || node.type !== 'ObjectExpression') return;

  // The far side of this relation carries the foreign key back to the parent,
  // and Prisma fills it in for a nested write.
  const inverse = target.fields.find(f =>
    f.kind === 'object' && f.relationName === relField.relationName && f.type !== target.name);
  const implied = new Set(inverse?.relationFromFields || []);

  for (const op of keysOf(node)) {
    if (op.name === 'createMany') {
      checkData(file, target, prop(op.value, 'data'), label, true, implied);
    } else if (op.name === 'connectOrCreate') {
      forEachObject(op.value, entry => {
        checkData(file, target, prop(entry, 'create'), label, true, implied);
        checkWhere(file, target, prop(entry, 'where'), label);
      });
    } else if (op.name === 'update' || op.name === 'updateMany' || op.name === 'upsert') {
      forEachObject(op.value, entry => {
        checkWhere(file, target, prop(entry, 'where'), label);
        checkData(file, target, prop(entry, 'data'), label);
        checkData(file, target, prop(entry, 'create'), label, true, implied);
        checkData(file, target, prop(entry, 'update'), label);
      });
    } else if (NESTED_WRITE.has(op.name)) {
      checkData(file, target, op.value, label, op.name === 'create', implied);
    } else if (NESTED_WHERE.has(op.name)) {
      forEachObject(op.value, entry => checkWhere(file, target, entry, label));
    }
  }
}

/** Apply fn to an object literal, or to each object in an array literal. */
function forEachObject(node, fn) {
  if (!node) return;
  if (node.type === 'ArrayExpression') {
    for (const el of node.elements) if (el && el.type === 'ObjectExpression') fn(el);
  } else if (node.type === 'ObjectExpression') {
    fn(node);
  }
}

/** where clauses: recurse through AND/OR/NOT, allow filter operators under a field. */
function checkWhere(file, model, node, label) {
  if (!node || node.type !== 'ObjectExpression') return;
  const names = fieldNames(model);
  for (const k of keysOf(node)) {
    if (LOGICAL.has(k.name)) {
      if (k.value.type === 'ArrayExpression') k.value.elements.forEach(e => checkWhere(file, model, e, label));
      else checkWhere(file, model, k.value, label);
      continue;
    }
    if (AGG.has(k.name)) continue;
    if (!names.has(k.name)) { record(file, k.line, model, k.name, label); continue; }
    const target = relationTarget(model, k.name);
    if (target && k.value.type === 'ObjectExpression') {
      for (const sub of keysOf(k.value)) {
        if (['some', 'every', 'none', 'is', 'isNot'].includes(sub.name)) checkWhere(file, target, sub.value, label);
      }
    }
  }
}

/** select / include: keys must be fields, and nested ones resolve through relations. */
function checkProjection(file, model, node, label) {
  if (!node || node.type !== 'ObjectExpression') return;
  const names = fieldNames(model);
  for (const k of keysOf(node)) {
    if (AGG.has(k.name)) continue;
    if (!names.has(k.name)) { record(file, k.line, model, k.name, label); continue; }
    const target = relationTarget(model, k.name);
    if (target && k.value.type === 'ObjectExpression') {
      checkProjection(file, target, prop(k.value, 'select'), label);
      checkProjection(file, target, prop(k.value, 'include'), label);
      checkWhere(file, target, prop(k.value, 'where'), label);
      checkOrderBy(file, target, prop(k.value, 'orderBy'), label);
    }
  }
}

function checkOrderBy(file, model, node, label) {
  if (!node) return;
  if (node.type === 'ArrayExpression') { node.elements.forEach(e => checkOrderBy(file, model, e, label)); return; }
  if (node.type !== 'ObjectExpression') return;
  const names = fieldNames(model);
  for (const k of keysOf(node)) {
    if (AGG.has(k.name)) continue;
    if (!names.has(k.name)) record(file, k.line, model, k.name, label);
  }
}

function checkCall(file, model, op, arg) {
  if (!arg || arg.type !== 'ObjectExpression') return;
  checkWhere(file, model, prop(arg, 'where'), 'where');
  checkProjection(file, model, prop(arg, 'select'), 'select');
  checkProjection(file, model, prop(arg, 'include'), 'include');
  checkOrderBy(file, model, prop(arg, 'orderBy'), 'orderBy');
  if (op === 'upsert') {
    checkData(file, model, prop(arg, 'create'), 'create', true);
    checkData(file, model, prop(arg, 'update'), 'update');
  } else if (WRITE_OPS.has(op)) {
    checkData(file, model, prop(arg, 'data'), 'data', op === 'create' || op === 'createMany');
  }
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => c && typeof c.type === 'string' && walk(c, visit, node));
    else if (child && typeof child.type === 'string') walk(child, visit, node);
  }
}

function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parser.parse(src, { sourceType: 'unambiguous', plugins: ['jsx', 'optionalChaining', 'nullishCoalescingOperator'] });
  } catch (e) {
    console.error(`parse failed: ${file}: ${e.message}`);
    return;
  }
  walk(ast, node => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;
    const op = callee.property.name;
    if (!OPS.has(op)) return;
    const owner = callee.object;
    if (!owner || owner.type !== 'MemberExpression' || owner.computed) return;
    const delegate = owner.property.name;
    const model = MODELS.get(delegate);
    if (!model) return;
    checkCall(path.relative(path.join(__dirname, '..'), file), model, op, node.arguments[0]);
  });
}

function collectFiles(root) {
  const full = path.resolve(root);
  const stat = fs.statSync(full);
  if (!stat.isDirectory()) return [full];
  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(full, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'generated') continue;
      out.push(...collectFiles(child));
    } else if (entry.name.endsWith('.js')) {
      out.push(child);
    }
  }
  return out;
}

/** @returns {{file:string,line:number,model:string,key:string,where:string}[]} */
function checkPaths(roots) {
  findings.length = 0;
  for (const root of roots) collectFiles(root).forEach(scan);
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings.slice();
}

function report(results) {
  const byFile = new Map();
  for (const f of results) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const lines = [];
  for (const [file, list] of byFile) {
    lines.push(`\n${file}  (${list.length})`);
    for (const f of list) lines.push(`  ${String(f.line).padStart(5)}  ${f.model}.${f.key}  [${f.where}]`);
  }
  lines.push(`\nTOTAL: ${results.length} unknown field references in ${byFile.size} files`);
  return lines.join('\n');
}

module.exports = { checkPaths, report };

if (require.main === module) {
  const roots = process.argv.slice(2);
  if (!roots.length) roots.push('src');
  const results = checkPaths(roots);
  console.log(report(results));
  process.exit(results.length ? 1 : 0);
}
