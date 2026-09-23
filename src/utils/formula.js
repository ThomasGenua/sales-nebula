/**
 * Formula fields, evaluated without running code.
 *
 * Formulas used to be turned into JavaScript and handed to `new Function`,
 * with any word that was not a field left in place. A formula was therefore a
 * program: `process.mainModule.require('child_process').execSync(...)` ran on
 * the server, and /api/formulas/test took one from anyone with settings: read.
 *
 * This is a small parser and interpreter instead. It knows literals, record
 * fields, the functions below, and arithmetic, comparison, logical and
 * conditional operators. It has no property access, calls only the functions
 * listed here, and reads a field only when the record itself has it, so there
 * is nothing that reaches past the record.
 */

const FUNCTIONS = {
  NOW: () => new Date(),
  TODAY: () => new Date(new Date().toISOString().split('T')[0]),
  DATEDIFF: (a, b) => (a && b ? Math.round((new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24)) : 0),
  IF: (cond, trueVal, falseVal) => (cond ? trueVal : falseVal),
  MAX: (...args) => Math.max(...args.filter(a => typeof a === 'number')),
  MIN: (...args) => Math.min(...args.filter(a => typeof a === 'number')),
  ROUND: (n, d = 0) => Number(Number(n).toFixed(d)),
  ABS: n => Math.abs(n),
  UPPER: s => String(s ?? '').toUpperCase(),
  LOWER: s => String(s ?? '').toLowerCase(),
  LEN: s => String(s ?? '').length,
  CONCAT: (...args) => args.map(a => a ?? '').join(''),
  ISNULL: v => v == null || v === '',
  NULLVALUE: (v, def) => (v == null || v === '' ? def : v),
};

const MAX_LENGTH = 2000;
const MAX_DEPTH = 50;
const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '(', ')', ',', '&'];

class FormulaError extends Error {}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i));
      if (!m) throw new FormulaError(`Unexpected "${ch}"`);
      tokens.push({ type: 'number', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = '';
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          value += source[j++];
        }
      }
      if (j >= source.length) throw new FormulaError('Unterminated string');
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: 'name', value: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find(o => source.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected "${ch}"`);
    tokens.push({ type: 'op', value: op });
    i += op.length;
  }
  return tokens;
}

const own = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
const comparable = v => (v instanceof Date ? v.getTime() : v);

function evaluate(tokens, record) {
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = value => peek()?.type === 'op' && peek().value === value;
  const expect = value => {
    if (!isOp(value)) throw new FormulaError(`Expected "${value}"`);
    pos++;
  };
  const nested = fn => {
    if (++depth > MAX_DEPTH) throw new FormulaError('Formula is nested too deeply');
    try { return fn(); } finally { depth--; }
  };

  const expression = () => nested(() => {
    const condition = logicalOr();
    if (!isOp('?')) return condition;
    pos++;
    const whenTrue = expression();
    expect(':');
    const whenFalse = expression();
    return condition ? whenTrue : whenFalse;
  });

  const binary = (next, ops, apply) => () => {
    let left = next();
    while (peek()?.type === 'op' && ops.includes(peek().value)) {
      const op = tokens[pos++].value;
      left = apply(op, left, next());
    }
    return left;
  };

  const unary = () => nested(() => {
    if (isOp('!')) { pos++; return !unary(); }
    if (isOp('-')) { pos++; return -unary(); }
    if (isOp('+')) { pos++; return +unary(); }
    return primary();
  });

  const multiplicative = binary(unary, ['*', '/', '%'], (op, a, b) => (op === '*' ? a * b : op === '/' ? a / b : a % b));
  const additive = binary(multiplicative, ['+', '-', '&'], (op, a, b) => {
    if (op === '&') return `${a ?? ''}${b ?? ''}`;
    if (op === '-') return a - b;
    return typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : a + b;
  });
  const comparison = binary(additive, ['<', '<=', '>', '>='], (op, a, b) => {
    const [x, y] = [comparable(a), comparable(b)];
    return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
  });
  const equality = binary(comparison, ['==', '===', '!=', '!=='], (op, a, b) => {
    const same = comparable(a) === comparable(b);
    return op === '==' || op === '===' ? same : !same;
  });
  const logicalAnd = binary(equality, ['&&'], (op, a, b) => a && b);
  const logicalOr = binary(logicalAnd, ['||'], (op, a, b) => a || b);

  function primary() {
    const token = tokens[pos++];
    if (!token) throw new FormulaError('Formula ended too soon');
    if (token.type === 'number' || token.type === 'string') return token.value;
    if (token.type === 'op' && token.value === '(') {
      const value = expression();
      expect(')');
      return value;
    }
    if (token.type === 'name') {
      if (isOp('(')) {
        if (!own(FUNCTIONS, token.value)) throw new FormulaError(`Unknown function: ${token.value}`);
        pos++;
        const args = [];
        if (!isOp(')')) {
          do { args.push(expression()); } while (isOp(',') && ++pos);
        }
        expect(')');
        return FUNCTIONS[token.value](...args);
      }
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      // A field on the record itself; anything else is empty.
      return own(record, token.value) ? record[token.value] : null;
    }
    throw new FormulaError(`Unexpected "${token.value}"`);
  }

  const value = expression();
  if (pos < tokens.length) throw new FormulaError(`Unexpected "${tokens[pos].value}"`);
  return value;
}

/** A formula's value for a record, or { error } when it cannot be read. */
function evaluateFormula(formula, record) {
  try {
    const source = String(formula ?? '');
    if (source.length > MAX_LENGTH) throw new FormulaError(`Formula is longer than ${MAX_LENGTH} characters`);
    return evaluate(tokenize(source), record && typeof record === 'object' ? record : {});
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { evaluateFormula, FUNCTIONS };
