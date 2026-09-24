/**
 * Inverted-index full-text search.
 *
 * The previous search hit every table with `contains` (SQL ILIKE
 * '%term%'), which cannot use an index and degrades linearly with row
 * count. This builds a real posting list: documents are tokenized once
 * at write time, and queries hit an indexed term column and rank with
 * BM25.
 *
 * Everything here is pure so it can be tested without a database.
 */

// Terms with no discriminating power. Dropped at index and query time.
const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','did','do','does',
  'for','from','had','has','have','he','her','him','his','how','i','if','in','into',
  'is','it','its','me','my','no','not','of','on','or','our','out','she','so','than',
  'that','the','their','them','then','there','these','they','this','to','too','up',
  'us','was','we','were','what','when','where','which','who','why','will','with',
  'would','you','your',
]);

// Field weights. A hit in the title outranks the same hit in the body.
const FIELD_WEIGHTS = { title: 6.0, subtitle: 3.0, keywords: 2.5, body: 1.0 };

// BM25 tuning. k1 controls term-frequency saturation, b length normalization.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Fold accents so "Montreal" matches "Montréal". */
function foldAccents(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Light suffix stemmer. Deliberately conservative: over-stemming
 * produces false matches that are worse than missing an inflection.
 */
function stem(word) {
  let w = String(word).toLowerCase();
  if (w.length <= 3) return w;

  // Plurals
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ses') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3) w = w.slice(0, -1);

  // Common verb and adjective suffixes
  if (w.endsWith('ing') && w.length > 5) {
    w = w.slice(0, -3);
    if (/([bdfglmnprt])\1$/.test(w)) w = w.slice(0, -1);
  } else if (w.endsWith('edly')) w = w.slice(0, -4);
  else if (w.endsWith('ed') && w.length > 4 && !w.endsWith('eed')) {
    w = w.slice(0, -2);
    if (/([bdfglmnprt])\1$/.test(w)) w = w.slice(0, -1);
  }
  if (w.endsWith('ly') && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith('ment') && w.length > 6) w = w.slice(0, -4);

  return w;
}

/**
 * Split text into normalized tokens.
 * Emails, URLs, phone numbers, and identifiers survive intact because
 * users search for them literally.
 */
function tokenize(text, { keepStopWords = false, applyStemming = true } = {}) {
  if (!text) return [];
  const source = foldAccents(String(text)).toLowerCase();
  const tokens = [];

  // Preserve structured identifiers before generic splitting
  const structured = [];
  const preserved = source
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, m => { structured.push(m); return ` \u0000${structured.length - 1}\u0000 `; })
    .replace(/https?:\/\/[^\s]+/g, m => { structured.push(m.replace(/[.,;)]+$/, '')); return ` \u0000${structured.length - 1}\u0000 `; })
    .replace(/\+?\d[\d\s().-]{6,}\d/g, m => { structured.push(m.replace(/\D/g, '')); return ` \u0000${structured.length - 1}\u0000 `; })
    .replace(/\b[a-z]{2,6}[-_]?\d{2,}\b/g, m => { structured.push(m); return ` \u0000${structured.length - 1}\u0000 `; });

  for (const raw of preserved.split(/[^a-z0-9\u0000]+/)) {
    if (!raw) continue;
    const placeholder = raw.match(/^\u0000(\d+)\u0000$/);
    if (placeholder) { tokens.push(structured[+placeholder[1]]); continue; }
    if (raw.length < 2) continue;
    if (!keepStopWords && STOP_WORDS.has(raw)) continue;
    tokens.push(applyStemming ? stem(raw) : raw);
  }

  return tokens;
}

/**
 * Build the index payload for one record.
 * Returns tokens, per-field postings, and the stored token stream.
 */
function buildIndexEntry({ module, recordId, title, subtitle, body, keywords, ownerId, status, boost = 1.0 }) {
  const fields = { title, subtitle, keywords, body };
  const postings = new Map(); // term -> { field -> {frequency, positions[]} }
  const allTokens = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const tokens = tokenize(value);
    tokens.forEach((term, i) => {
      allTokens.push(term);
      if (!postings.has(term)) postings.set(term, {});
      const byField = postings.get(term);
      if (!byField[field]) byField[field] = { frequency: 0, positions: [] };
      byField[field].frequency++;
      if (byField[field].positions.length < 50) byField[field].positions.push(i);
    });
  }

  const flat = [];
  for (const [term, byField] of postings) {
    for (const [field, data] of Object.entries(byField)) {
      flat.push({ term, field, frequency: data.frequency, positions: data.positions.join(',') });
    }
  }

  return {
    module, recordId,
    title: title || '(untitled)',
    subtitle: subtitle || null,
    body: body ? String(body).slice(0, 8000) : null,
    keywords: keywords || null,
    tokens: [...new Set(allTokens)].join(' '),
    tokenCount: allTokens.length,
    ownerId: ownerId || null,
    status: status || null,
    boost,
    postings: flat,
    uniqueTerms: postings.size,
  };
}

/**
 * Parse a query string into structured clauses.
 *
 *   "exact phrase"    phrase match
 *   -excluded         must not appear
 *   +required         must appear
 *   field:value       field-scoped filter
 *   prefix*           prefix match
 */
function parseQuery(query) {
  if (!query) return { terms: [], phrases: [], required: [], excluded: [], filters: {}, prefixes: [], raw: '' };

  const result = { terms: [], phrases: [], required: [], excluded: [], filters: {}, prefixes: [], raw: String(query).trim() };
  let working = String(query);

  // Quoted phrases first
  working = working.replace(/"([^"]+)"/g, (m, phrase) => {
    const tokens = tokenize(phrase);
    if (tokens.length) result.phrases.push({ text: phrase.trim(), tokens });
    return ' ';
  });

  for (const chunk of working.split(/\s+/)) {
    if (!chunk) continue;

    const filter = chunk.match(/^(\w+):(.+)$/);
    if (filter && ['module', 'owner', 'status', 'type'].includes(filter[1].toLowerCase())) {
      result.filters[filter[1].toLowerCase()] = filter[2];
      continue;
    }

    if (chunk.startsWith('-') && chunk.length > 1) {
      result.excluded.push(...tokenize(chunk.slice(1)));
      continue;
    }
    if (chunk.startsWith('+') && chunk.length > 1) {
      const t = tokenize(chunk.slice(1));
      result.required.push(...t);
      result.terms.push(...t);
      continue;
    }
    if (chunk.endsWith('*') && chunk.length > 2) {
      const base = foldAccents(chunk.slice(0, -1)).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (base.length >= 2) result.prefixes.push(base);
      continue;
    }

    result.terms.push(...tokenize(chunk));
  }

  // Phrase tokens participate in scoring too
  for (const p of result.phrases) result.terms.push(...p.tokens);
  result.terms = [...new Set(result.terms)];

  return result;
}

/** Inverse document frequency, floored so common terms still score. */
function idf(docCount, totalDocs) {
  if (!totalDocs || docCount <= 0) return 0;
  return Math.max(0.05, Math.log(1 + (totalDocs - docCount + 0.5) / (docCount + 0.5)));
}

/**
 * Score one document against a parsed query using BM25 with field
 * weighting. `postings` are that document's matching rows.
 */
function scoreDocument({ postings, tokenCount, boost = 1.0, avgTokenCount = 100, totalDocs = 1, docFrequencies = {} }) {
  if (!postings?.length) return 0;
  let score = 0;
  const lengthNorm = 1 - BM25_B + BM25_B * (tokenCount / Math.max(1, avgTokenCount));

  for (const posting of postings) {
    const weight = FIELD_WEIGHTS[posting.field] ?? 1.0;
    const tf = posting.frequency || 1;
    const saturated = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm);
    score += idf(docFrequencies[posting.term] ?? 1, totalDocs) * saturated * weight;
  }

  return +(score * (boost || 1)).toFixed(4);
}

/** True when a document's positions contain the phrase in order. */
function matchesPhrase(postingsByTerm, phraseTokens) {
  if (!phraseTokens.length) return false;
  if (phraseTokens.length === 1) return !!postingsByTerm[phraseTokens[0]];

  const positionSets = phraseTokens.map(t => {
    const entry = postingsByTerm[t];
    if (!entry) return null;
    const positions = Array.isArray(entry.positions)
      ? entry.positions
      : String(entry.positions || '').split(',').filter(Boolean).map(Number);
    return new Set(positions);
  });
  if (positionSets.some(s => !s || !s.size)) return false;

  for (const start of positionSets[0]) {
    if (positionSets.every((set, i) => set.has(start + i))) return true;
  }
  return false;
}

/** Build a highlighted excerpt around the first matching term. */
function buildSnippet(text, queryTerms, { length = 180, open = '<mark>', close = '</mark>' } = {}) {
  if (!text) return '';
  const source = String(text);
  const lower = foldAccents(source).toLowerCase();

  let anchor = -1;
  for (const term of queryTerms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (anchor < 0 || i < anchor)) anchor = i;
  }

  let start = 0;
  if (anchor > length / 2) {
    start = anchor - Math.floor(length / 3);
    const space = source.lastIndexOf(' ', start);
    if (space > 0) start = space + 1;
  }

  let excerpt = source.slice(start, start + length);
  if (start > 0) excerpt = '...' + excerpt;
  if (start + length < source.length) excerpt += '...';

  // Longest first, so "management" is not broken by "manage"
  const sorted = [...new Set(queryTerms)].filter(t => t.length >= 2).sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    excerpt = excerpt.replace(new RegExp(`(?<!${open.slice(0, -1)})\\b(${safe}\\w*)\\b`, 'gi'), `${open}$1${close}`);
  }

  return excerpt;
}

/**
 * Rank candidate documents. Applies required and excluded clauses,
 * phrase verification, then sorts by score.
 */
function rankResults(candidates, parsedQuery, { totalDocs = 1, avgTokenCount = 100, docFrequencies = {}, limit = 20 } = {}) {
  const ranked = [];

  for (const doc of candidates) {
    const byTerm = {};
    for (const p of doc.postings || []) {
      if (!byTerm[p.term] || p.field === 'title') byTerm[p.term] = p;
    }

    if (parsedQuery.excluded.some(t => byTerm[t])) continue;
    if (parsedQuery.required.length && !parsedQuery.required.every(t => byTerm[t])) continue;

    let phraseBonus = 0;
    let phraseOk = true;
    for (const phrase of parsedQuery.phrases) {
      if (matchesPhrase(byTerm, phrase.tokens)) phraseBonus += 12;
      else phraseOk = false;
    }
    if (parsedQuery.phrases.length && !phraseOk) continue;

    const base = scoreDocument({
      postings: doc.postings, tokenCount: doc.tokenCount, boost: doc.boost,
      avgTokenCount, totalDocs, docFrequencies,
    });
    if (base <= 0 && !phraseBonus) continue;

    // Prefer documents matching more of the query
    const coverage = parsedQuery.terms.length
      ? parsedQuery.terms.filter(t => byTerm[t]).length / parsedQuery.terms.length
      : 1;

    ranked.push({
      ...doc,
      score: +(base * (0.5 + 0.5 * coverage) + phraseBonus).toFixed(4),
      matchedTerms: Object.keys(byTerm),
      coverage: +coverage.toFixed(2),
    });
  }

  ranked.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
  return ranked.slice(0, limit);
}

/**
 * Expand query terms through a synonym table. Query terms are stemmed, so a
 * synonym is compared and added stemmed too: "customers" went into the query
 * as a term the index, which holds "customer", can never match.
 */
function expandSynonyms(terms, synonyms = []) {
  const norm = w => stem(foldAccents(String(w ?? '')).toLowerCase().trim());
  const expanded = new Set(terms);
  for (const t of terms) {
    for (const s of synonyms) {
      if (s.term === t || norm(s.term) === t) expanded.add(norm(s.synonym));
      else if (s.twoWay && (s.synonym === t || norm(s.synonym) === t)) expanded.add(norm(s.term));
    }
  }
  return [...expanded];
}

/** Suggest corrections for a term using bounded edit distance. */
function suggestCorrections(term, vocabulary, { maxDistance = 2, limit = 3 } = {}) {
  const candidates = [];
  for (const word of vocabulary) {
    if (Math.abs(word.length - term.length) > maxDistance) continue;
    const dist = editDistance(term, word, maxDistance);
    if (dist <= maxDistance && dist > 0) candidates.push({ word, distance: dist });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.word.length - b.word.length);
  return candidates.slice(0, limit).map(c => c.word);
}

/** Levenshtein distance with early exit once the bound is exceeded. */
function editDistance(a, b, maxDistance = Infinity) {
  if (a === b) return 0;
  if (!a.length) return b.length > maxDistance ? maxDistance + 1 : b.length;
  if (!b.length) return a.length > maxDistance ? maxDistance + 1 : a.length;
  // A length gap alone already exceeds the bound, so skip the matrix
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Field mapping per module: which columns feed which index field.
 * Adding a module here is all that is needed to make it searchable.
 */
const MODULE_INDEX_MAP = {
  contacts:  { title: r => `${r.firstName || ''} ${r.lastName || ''}`.trim(), subtitle: r => r.title || r.accountName, body: r => [r.email, r.phone, r.mobile, r.description].filter(Boolean).join(' '), keywords: r => [r.department, r.leadSource].filter(Boolean).join(' ') },
  leads:     { title: r => `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.company, subtitle: r => r.company, body: r => [r.email, r.phone, r.description, r.status].filter(Boolean).join(' '), keywords: r => [r.source || r.leadSource, r.industry].filter(Boolean).join(' ') },
  accounts:  { title: r => r.name, subtitle: r => r.industry, body: r => [r.website, r.phone, r.description, r.billingCity, r.billingCountry].filter(Boolean).join(' '), keywords: r => [r.type, r.accountNumber].filter(Boolean).join(' ') },
  deals:     { title: r => r.name, subtitle: r => r.stage, body: r => [r.description, r.nextStep, r.type].filter(Boolean).join(' '), keywords: r => [r.source || r.leadSource].filter(Boolean).join(' ') },
  cases:     { title: r => r.subject, subtitle: r => `${r.caseNumber || ''} ${r.status || ''}`.trim(), body: r => [r.description, r.resolution, r.contactEmail].filter(Boolean).join(' '), keywords: r => [r.type, r.priority, r.origin].filter(Boolean).join(' ') },
  products:  { title: r => r.name, subtitle: r => r.category || r.sku, body: r => [r.description, r.sku, r.manufacturer].filter(Boolean).join(' '), keywords: r => [r.category, r.type].filter(Boolean).join(' ') },
  // A quote's and an invoice's number is `number` (quoteNumber/invoiceNumber
  // stay empty) and their text is notes and terms: an invoice has no name, so
  // with neither title part set every invoice was skipped as untitled.
  quotes:    { title: r => `${r.quoteNumber || r.number || ''} ${r.name || ''}`.trim(), subtitle: r => r.status, body: r => [r.notes, r.terms].filter(Boolean).join(' '), keywords: r => r.stage },
  invoices:  { title: r => `${r.invoiceNumber || r.number || ''} ${r.name || ''}`.trim(), subtitle: r => r.status, body: r => [r.notes, r.terms].filter(Boolean).join(' '), keywords: null },
  contracts: { title: r => `${r.contractNumber || ''} ${r.name || ''}`.trim(), subtitle: r => r.status, body: r => r.description, keywords: r => r.type },
  documents: { title: r => r.name, subtitle: r => r.category, body: r => [r.description, r.fileName].filter(Boolean).join(' '), keywords: r => r.type },
  projects:  { title: r => r.name, subtitle: r => r.status, body: r => [r.description, r.code].filter(Boolean).join(' '), keywords: r => r.priority },
  campaigns: { title: r => r.name, subtitle: r => r.status, body: r => [r.description, r.objective].filter(Boolean).join(' '), keywords: r => r.type },
  prospects: { title: r => `${r.firstName || ''} ${r.lastName || ''}`.trim(), subtitle: r => r.accountName, body: r => [r.email, r.title, r.description].filter(Boolean).join(' '), keywords: r => [r.industry, r.source].filter(Boolean).join(' ') },
  bugs:      { title: r => r.title, subtitle: r => `${r.bugNumber || ''} ${r.status || ''}`.trim(), body: r => [r.description, r.stepsToReproduce, r.resolution].filter(Boolean).join(' '), keywords: r => [r.severity, r.component].filter(Boolean).join(' ') },
};

/** Project a raw record into index fields for its module. */
function projectRecord(module, record) {
  const map = MODULE_INDEX_MAP[module];
  if (!map || !record) return null;
  const pick = fn => { try { return fn ? fn(record) || null : null; } catch { return null; } };
  const title = pick(map.title);
  if (!title) return null;
  return {
    module, recordId: record.id,
    title: String(title).slice(0, 300),
    subtitle: pick(map.subtitle) ? String(pick(map.subtitle)).slice(0, 300) : null,
    body: pick(map.body),
    keywords: pick(map.keywords),
    ownerId: record.ownerId || record.assignedId || null,
    status: record.status || null,
  };
}

module.exports = {
  STOP_WORDS, FIELD_WEIGHTS, MODULE_INDEX_MAP,
  tokenize, stem, foldAccents,
  buildIndexEntry, projectRecord,
  parseQuery, scoreDocument, rankResults, matchesPhrase,
  buildSnippet, idf, expandSynonyms, suggestCorrections, editDistance,
};
