/**
 * Merge field engine for document templates.
 *
 * Supports the following syntax inside a template body:
 *
 *   {{contact.firstName}}              simple path
 *   {{account.address.city}}           nested path
 *   {{deal.amount|currency:USD}}       formatter with argument
 *   {{contact.firstName|upper}}        formatter
 *   {{contact.title|default:Unknown}}  fallback for empty values
 *   {{#each lineItems}} ... {{/each}}  repeating block
 *   {{#if discount}} ... {{/if}}       conditional block
 *   {{#unless paid}} ... {{/unless}}   inverted conditional
 *   {{@index}} {{@number}}             loop counters inside #each
 *
 * Rendering never throws on a missing field. Unresolved paths become an
 * empty string so a broken template degrades instead of failing a render.
 */

const FORMATTERS = {
  upper: v => String(v).toUpperCase(),
  lower: v => String(v).toLowerCase(),
  title: v => String(v).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  trim: v => String(v).trim(),

  currency: (v, code = 'USD') => {
    const n = Number(v);
    if (isNaN(n)) return '';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(n);
    } catch {
      return `${code} ${n.toFixed(2)}`;
    }
  },
  number: (v, decimals = '2') => {
    const n = Number(v);
    return isNaN(n) ? '' : n.toFixed(parseInt(decimals, 10));
  },
  percent: (v, decimals = '1') => {
    const n = Number(v);
    return isNaN(n) ? '' : `${n.toFixed(parseInt(decimals, 10))}%`;
  },
  round: v => {
    const n = Number(v);
    return isNaN(n) ? '' : String(Math.round(n));
  },

  // In UTC like `iso`: a date field is stored as UTC midnight, so on a server
  // west of UTC the other formats printed the day before.
  date: (v, fmt = 'medium') => {
    const d = new Date(v);
    if (isNaN(d)) return '';
    if (fmt === 'iso') return d.toISOString().slice(0, 10);
    if (fmt === 'short') return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'UTC' });
    if (fmt === 'long') return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  },
  datetime: v => {
    const d = new Date(v);
    return isNaN(d) ? '' : d.toLocaleString('en-US');
  },
  time: v => {
    const d = new Date(v);
    return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  },

  default: (v, fallback = '') => (v === null || v === undefined || v === '' ? fallback : v),
  yesno: v => (v ? 'Yes' : 'No'),
  checkbox: v => (v ? '[x]' : '[ ]'),
  nl2br: v => String(v).replace(/\r?\n/g, '<br/>'),
  truncate: (v, len = '100') => {
    const s = String(v);
    const n = parseInt(len, 10);
    return s.length > n ? s.slice(0, n) + '...' : s;
  },
  json: v => JSON.stringify(v),
};

/**
 * Escape a value for safe HTML output. Braces too: a record value holding
 * "{{owner.email}}" was otherwise read as a merge field by a later pass.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

/** Walk a dotted path against a context object. Returns undefined on a miss. */
function resolvePath(context, path) {
  if (!path) return undefined;
  const parts = String(path).trim().split('.');
  let cursor = context;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    // Support array index access such as lineItems.0.name
    if (Array.isArray(cursor) && /^\d+$/.test(part)) cursor = cursor[parseInt(part, 10)];
    else cursor = cursor[part];
  }
  return cursor;
}

/** Apply a pipe chain: value|formatter:arg|formatter */
function applyFormatters(value, chain) {
  let out = value;
  for (const step of chain) {
    const [name, ...argParts] = step.split(':');
    const fn = FORMATTERS[name.trim()];
    if (!fn) continue;
    const arg = argParts.join(':');
    // `default` must run even on an empty value; the rest short-circuit
    if (name.trim() !== 'default' && (out === null || out === undefined || out === '')) continue;
    out = arg ? fn(out, arg) : fn(out);
  }
  return out;
}

/** Truthiness for #if and #unless, treating empty arrays and "0" as false. */
function isTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value === '0' || value === 0) return false;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
  return !!value;
}

/** Substitute {{...}} expressions in one pass. */
function substitute(template, context, { escape = true } = {}) {
  return String(template).replace(/\{\{\s*([^#/@}][^}]*?)\s*\}\}/g, (match, expr) => {
    const [pathPart, ...formatterChain] = expr.split('|').map(s => s.trim());
    // nl2br makes markup, so when escaping it runs after the escape: its
    // <br/> tags were escaped with the value and printed as text.
    const isBreaks = step => step.split(':')[0].trim() === 'nl2br';
    const breaks = escape && formatterChain.some(isBreaks);
    let value = resolvePath(context, pathPart);
    if (formatterChain.length) value = applyFormatters(value, breaks ? formatterChain.filter(s => !isBreaks(s)) : formatterChain);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';
    if (!escape) return String(value);
    return breaks ? escapeHtml(value).replace(/\r?\n/g, '<br/>') : escapeHtml(value);
  });
}

/**
 * Expand {{#each list}}...{{/each}} blocks. A block ends at its own
 * {{/each}}, and a block nested in it is expanded in each item's scope.
 * Taking the first {{/each}} paired an outer block with its inner block's
 * end, so nested loops came out garbled.
 */
function expandLoops(template, context, opts) {
  const open = /\{\{#each\s+([\w.]+)\s*\}\}/g;
  const tags = /\{\{#each\s+[\w.]+\s*\}\}|\{\{\/each\}\}/g;
  let out = String(template);
  let guard = 0;
  let m;

  while ((m = open.exec(out)) && guard++ < 100) {
    tags.lastIndex = m.index + m[0].length;
    let depth = 1;
    let tag;
    while (depth && (tag = tags.exec(out))) depth += tag[0] === '{{/each}}' ? -1 : 1;
    if (depth) continue; // unclosed; render() strips the stray tag
    const body = out.slice(m.index + m[0].length, tag.index);
    const list = resolvePath(context, m[1]);
    const expanded = !Array.isArray(list) || !list.length ? '' : list.map((item, i) => {
      const scope = {
        ...context,
        ...(typeof item === 'object' && item !== null ? item : { this: item }),
        this: item,
        '@index': i,
        '@number': i + 1,
        '@first': i === 0,
        '@last': i === list.length - 1,
        '@odd': i % 2 === 1,
        '@even': i % 2 === 0,
      };
      let chunk = expandLoops(body, scope, opts);
      chunk = expandConditionals(chunk, scope);
      chunk = chunk.replace(/\{\{\s*@(\w+)\s*\}\}/g, (match, k) => {
        const v = scope[`@${k}`];
        return v === undefined ? '' : String(v);
      });
      return substitute(chunk, scope, opts);
    }).join('');
    out = out.slice(0, m.index) + expanded + out.slice(tag.index + tag[0].length);
    open.lastIndex = m.index + expanded.length;
  }
  return out;
}

/**
 * Expand {{#if}} and {{#unless}} blocks, with optional {{else}}. Innermost
 * first: taking the first {{/if}} after an outer {{#if}} closed it at the
 * inner block's end, so nested conditionals showed the wrong branch.
 */
function expandConditionals(template, context) {
  let out = String(template);
  let guard = 0;

  const ifPattern = /\{\{#if\s+([\w.]+)\s*\}\}((?:(?!\{\{#if\s)[\s\S])*?)\{\{\/if\}\}/;
  while (ifPattern.test(out) && guard++ < 100) {
    out = out.replace(ifPattern, (match, path, body) => {
      const [truthy, falsy = ''] = body.split(/\{\{else\}\}/);
      return isTruthy(resolvePath(context, path)) ? truthy : falsy;
    });
  }

  guard = 0;
  const unlessPattern = /\{\{#unless\s+([\w.]+)\s*\}\}((?:(?!\{\{#unless\s)[\s\S])*?)\{\{\/unless\}\}/;
  while (unlessPattern.test(out) && guard++ < 100) {
    out = out.replace(unlessPattern, (match, path, body) =>
      isTruthy(resolvePath(context, path)) ? '' : body);
  }

  return out;
}

/**
 * Render a template against a context.
 * Order matters: loops first so nested conditionals see loop scope,
 * then top-level conditionals, then plain substitution.
 */
function render(template, context, opts = {}) {
  if (!template) return '';
  let out = String(template);
  out = expandLoops(out, context, opts);
  out = expandConditionals(out, context);
  out = substitute(out, context, opts);
  // Strip any block tags left behind by an unbalanced template
  out = out.replace(/\{\{[#/](?:each|if|unless)[^}]*\}\}/g, '').replace(/\{\{else\}\}/g, '');
  return out;
}

/** Extract every merge field referenced by a template, for validation. */
function extractMergeFields(template) {
  if (!template) return [];
  const fields = new Set();
  const simple = String(template).matchAll(/\{\{\s*([^#/@}][^}|]*?)(?:\|[^}]*)?\s*\}\}/g);
  for (const m of simple) {
    const path = m[1].trim();
    if (path && !path.startsWith('@') && path !== 'this') fields.add(path);
  }
  const blocks = String(template).matchAll(/\{\{#(?:each|if|unless)\s+([\w.]+)\s*\}\}/g);
  for (const m of blocks) fields.add(m[1].trim());
  return [...fields].sort();
}

/** Validate template syntax. Returns { valid, errors, warnings }. */
function validateTemplate(template) {
  const errors = [];
  const warnings = [];
  if (!template) return { valid: false, errors: ['Template body is empty'], warnings };

  const s = String(template);
  const pairs = [['#each', '/each'], ['#if', '/if'], ['#unless', '/unless']];
  for (const [open, close] of pairs) {
    const opens = (s.match(new RegExp(`\\{\\{${open}\\b`, 'g')) || []).length;
    const closes = (s.match(new RegExp(`\\{\\{\\${close}\\}\\}`, 'g')) || []).length;
    if (opens !== closes) errors.push(`Unbalanced ${open} block: ${opens} opened, ${closes} closed`);
  }

  const braces = (s.match(/\{\{/g) || []).length - (s.match(/\}\}/g) || []).length;
  if (braces !== 0) errors.push('Unbalanced braces in merge expressions');

  for (const m of s.matchAll(/\{\{\s*[^#/@}][^}|]*\|([^}]+)\}\}/g)) {
    for (const step of m[1].split('|')) {
      const name = step.split(':')[0].trim();
      if (name && !FORMATTERS[name]) warnings.push(`Unknown formatter: ${name}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)], fields: extractMergeFields(s) };
}

/**
 * Build a render context from a record plus its related data.
 * Adds computed helpers templates commonly need.
 */
function buildContext(module, record, related = {}, extras = {}) {
  const singular = module.replace(/s$/, '');
  const now = new Date();

  const context = {
    ...related,
    [singular]: record,
    record,
    today: now,
    now,
    system: {
      date: now.toLocaleDateString('en-US'),
      time: now.toLocaleTimeString('en-US'),
      year: now.getFullYear(),
      ...extras.system,
    },
    ...extras,
  };

  // Totals for line-item documents
  const rows = related.lineItems || record?.lineItems || record?.items;
  if (Array.isArray(rows)) {
    // The documented {{name}} and {{total}}, whatever the line model calls
    // them: quote lines have description and totalPrice, so starter templates
    // printed blank items and the subtotal ignored line discounts.
    const items = rows.map(i => (i && typeof i === 'object' ? {
      ...i,
      name: i.name ?? i.product?.name ?? i.description ?? null,
      total: i.total ?? i.totalPrice ?? null,
    } : i));
    const subtotal = items.reduce((s, i) => s + (Number(i.total) || Number(i.amount) || (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0)), 0);
    const taxTotal = items.reduce((s, i) => s + (Number(i.taxAmount) || 0), 0);
    const discountTotal = items.reduce((s, i) => s + (Number(i.discountAmount) || 0), 0);
    context.lineItems = items;
    context.totals = {
      itemCount: items.length,
      subtotal: +subtotal.toFixed(2),
      tax: +taxTotal.toFixed(2),
      discount: +discountTotal.toFixed(2),
      grandTotal: +(subtotal + taxTotal - discountTotal).toFixed(2),
    };
  }

  return context;
}

/** Assemble a complete printable HTML document. */
function buildDocument(template, context, opts = {}) {
  const body = render(template.bodyHtml, context, opts);
  const header = template.headerHtml ? render(template.headerHtml, context, opts) : '';
  const footer = template.footerHtml ? render(template.footerHtml, context, opts) : '';

  const size = template.pageSize || 'A4';
  const orientation = template.orientation || 'portrait';
  const margins = `${template.marginTop ?? 20}mm ${template.marginRight ?? 15}mm ${template.marginBottom ?? 20}mm ${template.marginLeft ?? 15}mm`;
  // Rendered raw and escaped once; render() escaped it already, so "A&B" read "A&amp;B".
  const title = escapeHtml(render(template.name || 'Document', context, { escape: false }));

  return `<!DOCTYPE html>
<html lang="${template.locale || 'en'}">
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
@page { size: ${size} ${orientation}; margin: ${margins}; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #ddd; }
th { background: #f4f4f4; font-weight: 600; font-size: 10pt; text-transform: uppercase; letter-spacing: 0.04em; }
.text-right { text-align: right; } .text-center { text-align: center; }
.totals td { border: none; padding: 4px 10px; }
.totals .grand { font-weight: 700; font-size: 13pt; border-top: 2px solid #1a1a1a; }
h1 { font-size: 20pt; margin: 0 0 4px; } h2 { font-size: 14pt; margin: 16px 0 6px; }
.header { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; margin-bottom: 18px; }
.footer { border-top: 1px solid #ddd; padding-top: 8px; margin-top: 24px; font-size: 9pt; color: #666; }
.muted { color: #666; } .badge { display: inline-block; padding: 2px 8px; border-radius: 3px; background: #eee; font-size: 9pt; }
${template.css || ''}
</style>
</head>
<body>
${header ? `<div class="header">${header}</div>` : ''}
<main>${body}</main>
${footer ? `<div class="footer">${footer}</div>` : ''}
</body>
</html>`;
}

/**
 * Starter templates offered in the UI when a module has none. A quote's and
 * an invoice's number is `number` (quoteNumber and invoiceNumber are left
 * empty), and a quote has notes, not a description; the starters printed blanks.
 */
const STARTER_TEMPLATES = {
  quotes: {
    name: 'Standard Quote',
    bodyHtml: `<h1>Quote {{quote.number}}</h1>
<p class="muted">Issued {{quote.createdAt|date}} | Valid until {{#if quote.expirationDate}}{{quote.expirationDate|date}}{{else}}{{quote.validUntil|date}}{{/if}}</p>

<h2>Prepared for</h2>
<p>{{account.name}}<br/>{{contact.firstName}} {{contact.lastName}}<br/>{{contact.email}}</p>

<table>
<thead><tr><th>#</th><th>Item</th><th class="text-right">Qty</th><th class="text-right">Unit</th><th class="text-right">Total</th></tr></thead>
<tbody>
{{#each lineItems}}
<tr><td>{{@number}}</td><td>{{name}}</td><td class="text-right">{{quantity}}</td><td class="text-right">{{unitPrice|currency}}</td><td class="text-right">{{total|currency}}</td></tr>
{{/each}}
</tbody>
</table>

<table class="totals">
<tr><td class="text-right">Subtotal</td><td class="text-right" style="width:120px">{{totals.subtotal|currency}}</td></tr>
{{#if totals.discount}}<tr><td class="text-right">Discount</td><td class="text-right">-{{totals.discount|currency}}</td></tr>{{/if}}
<tr><td class="text-right">Tax</td><td class="text-right">{{totals.tax|currency}}</td></tr>
<tr class="grand"><td class="text-right">Total</td><td class="text-right">{{totals.grandTotal|currency}}</td></tr>
</table>

{{#if quote.notes}}<h2>Notes</h2><p>{{quote.notes|nl2br}}</p>{{/if}}`,
    footerHtml: '<p>{{system.year}} | Generated {{system.date}}</p>',
  },
  invoices: {
    name: 'Standard Invoice',
    bodyHtml: `<h1>Invoice {{invoice.number}}</h1>
<p class="muted">Date {{invoice.createdAt|date}} | Due {{invoice.dueDate|date}}</p>
<p><span class="badge">{{invoice.status}}</span></p>

<h2>Bill to</h2>
<p>{{account.name}}<br/>{{account.billingStreet}}<br/>{{account.billingCity}}</p>

<table>
<thead><tr><th>Description</th><th class="text-right">Qty</th><th class="text-right">Amount</th></tr></thead>
<tbody>
{{#each lineItems}}
<tr><td>{{name}}</td><td class="text-right">{{quantity}}</td><td class="text-right">{{total|currency}}</td></tr>
{{/each}}
</tbody>
</table>

<table class="totals">
<tr><td class="text-right">Subtotal</td><td class="text-right" style="width:120px">{{totals.subtotal|currency}}</td></tr>
<tr><td class="text-right">Tax</td><td class="text-right">{{totals.tax|currency}}</td></tr>
<tr class="grand"><td class="text-right">Amount Due</td><td class="text-right">{{totals.grandTotal|currency}}</td></tr>
</table>`,
  },
  cases: {
    name: 'Case Summary',
    bodyHtml: `<h1>Case {{case.caseNumber}}: {{case.subject}}</h1>
<p class="muted">Opened {{case.createdAt|date}} | Priority {{case.priority}} | Status {{case.status}}</p>
<h2>Account</h2><p>{{account.name}}</p>
<h2>Description</h2><p>{{case.description|nl2br|default:No description provided}}</p>
{{#if case.resolution}}<h2>Resolution</h2><p>{{case.resolution|nl2br}}</p>{{/if}}`,
  },
};

module.exports = {
  render, substitute, resolvePath, applyFormatters,
  expandLoops, expandConditionals, extractMergeFields, validateTemplate,
  buildContext, buildDocument, escapeHtml, isTruthy,
  FORMATTERS, STARTER_TEMPLATES,
};
