'use strict';

/*
 * Full-text search engine for Sales Nebula.
 *
 * Replaces the previous approach of issuing N Prisma `contains` filters
 * (which compile to ILIKE '%term%' and force a sequential scan of every
 * searchable table on every keystroke).
 *
 * Instead we maintain an inverted index: documents are tokenized once at
 * write time into SearchIndex + SearchPosting rows, and queries resolve
 * against the posting list with BM25 relevance ranking.
 *
 * Implemented from published specifications with no third party
 * dependency: Porter stemming algorithm (Porter, 1980) and Okapi BM25
 * (Robertson and Walker, 1994).
 */

// ─── Stopwords ───────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'me', 'more', 'most',
  'my', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or',
  'other', 'ought', 'our', 'ours', 'out', 'over', 'own', 'same', 'she',
  'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would',
  'you', 'your', 'yours',
]);

// Field weights used by BM25F style scoring. Title matches count for far
// more than body matches so that searching an account name surfaces the
// account itself rather than every note that mentions it.
const FIELD_WEIGHTS = {
  title: 8.0,
  subtitle: 3.0,
  keywords: 4.0,
  body: 1.0,
};

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_LENGTH = 40;

// ─── Porter stemmer ──────────────────────────────────────────

const VOWELS = 'aeiou';

function isConsonant(word, i) {
  const ch = word[i];
  if (VOWELS.includes(ch)) return false;
  if (ch === 'y') return i === 0 ? true : !isConsonant(word, i - 1);
  return true;
}

/* Measure: the number of vowel-consonant sequences in the stem. */
function measure(stem) {
  let n = 0;
  let i = 0;
  const len = stem.length;
  while (i < len && isConsonant(stem, i)) i += 1;
  while (i < len) {
    while (i < len && !isConsonant(stem, i)) i += 1;
    if (i >= len) break;
    n += 1;
    while (i < len && isConsonant(stem, i)) i += 1;
  }
  return n;
}

function containsVowel(stem) {
  for (let i = 0; i < stem.length; i += 1) {
    if (!isConsonant(stem, i)) return true;
  }
  return false;
}

function endsDoubleConsonant(word) {
  if (word.length < 2) return false;
  const a = word.length - 1;
  if (word[a] !== word[a - 1]) return false;
  return isConsonant(word, a);
}

/* CVC pattern where the final consonant is not w, x or y. */
function endsCvc(word) {
  if (word.length < 3) return false;
  const a = word.length - 1;
  if (!isConsonant(word, a) || isConsonant(word, a - 1) || !isConsonant(word, a - 2)) {
    return false;
  }
  return !'wxy'.includes(word[a]);
}

function replaceSuffix(word, suffix, replacement, minMeasure) {
  if (!word.endsWith(suffix)) return null;
  const stem = word.slice(0, word.length - suffix.length);
  if (minMeasure !== undefined && measure(stem) <= minMeasure) return null;
  return stem + replacement;
}

const STEP2_MAP = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
  ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
  ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
  ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
  ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];

const STEP3_MAP = [
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
  ['ical', 'ic'], ['ful', ''], ['ness', ''],
];

const STEP4_SUFFIXES = [
  'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement',
  'ment', 'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
];

function stem(word) {
  if (!word || word.length <= 2) return word;
  let w = word;

  // Step 1a: plurals
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) { /* leave */ }
  else if (w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b: past tense and gerunds
  let step1bApplied = false;
  if (w.endsWith('eed')) {
    const candidate = w.slice(0, -1);
    if (measure(w.slice(0, -3)) > 0) w = candidate;
  } else if (w.endsWith('ed') && containsVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    step1bApplied = true;
  } else if (w.endsWith('ing') && containsVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    step1bApplied = true;
  }

  if (step1bApplied) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w += 'e';
    } else if (endsDoubleConsonant(w) && !'lsz'.includes(w[w.length - 1])) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && endsCvc(w)) {
      w += 'e';
    }
  }

  // Step 1c: terminal y to i
  if (w.endsWith('y') && containsVowel(w.slice(0, -1))) {
    w = `${w.slice(0, -1)}i`;
  }

  // Step 2
  for (const [suffix, replacement] of STEP2_MAP) {
    const result = replaceSuffix(w, suffix, replacement, 0);
    if (result !== null) { w = result; break; }
  }

  // Step 3
  for (const [suffix, replacement] of STEP3_MAP) {
    const result = replaceSuffix(w, suffix, replacement, 0);
    if (result !== null) { w = result; break; }
  }

  // Step 4
  for (const suffix of STEP4_SUFFIXES) {
    if (!w.endsWith(suffix)) continue;
    const candidate = w.slice(0, w.length - suffix.length);
    if (measure(candidate) <= 1) continue;
    if ((suffix === 'ion') && !/[st]$/.test(candidate)) continue;
    w = candidate;
    break;
  }
  if (w.endsWith('ion')) {
    const candidate = w.slice(0, -3);
    if (measure(candidate) > 1 && /[st]$/.test(candidate)) w = candidate;
  }

  // Step 5a
  if (w.endsWith('e')) {
    const candidate = w.slice(0, -1);
    const m = measure(candidate);
    if (m > 1 || (m === 1 && !endsCvc(candidate))) w = candidate;
  }

  // Step 5b
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith('l')) {
    w = w.slice(0, -1);
  }

  return w;
}

// ─── Tokenization ────────────────────────────────────────────

/*
 * Normalize text into a comparable form. Strips diacritics so that
 * "Bogota" matches "Bogotá", lowercases, and collapses punctuation to
 * spaces while keeping intra-word marks that carry meaning in business
 * data (dots in domains, dashes in part numbers, @ in email).
 */
function normalizeText(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@._\-+\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Split normalized text into tokens. Email addresses and domains are
 * emitted whole and also split on their separators, so a search for
 * "acme" finds "billing@acme.com" and a search for the full address
 * finds it too.
 */
function tokenize(text, options = {}) {
  const { keepStopwords = false, applyStemming = true } = options;
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const raw = normalized.split(' ').filter(Boolean);
  const out = [];

  for (const piece of raw) {
    if (piece.length > MAX_TOKEN_LENGTH) continue;
    const parts = new Set([piece]);

    if (piece.includes('@') || piece.includes('.') || piece.includes('-') || piece.includes('_')) {
      for (const sub of piece.split(/[@._\-+]/)) {
        if (sub.length >= MIN_TOKEN_LENGTH) parts.add(sub);
      }
    }

    for (const part of parts) {
      const cleaned = part.replace(/^[._\-+]+|[._\-+]+$/g, '');
      if (cleaned.length < MIN_TOKEN_LENGTH) continue;
      if (!keepStopwords && STOPWORDS.has(cleaned)) continue;
      out.push(applyStemming && /^[a-z]+$/.test(cleaned) ? stem(cleaned) : cleaned);
    }
  }

  return out;
}

/*
 * Build the posting data for one field of a document. Returns a map of
 * term to {frequency, positions}. Positions are retained so that phrase
 * queries can verify adjacency rather than merely co-occurrence.
 */
function buildPostings(text, field = 'body') {
  const tokens = tokenize(text);
  const postings = new Map();
  tokens.forEach((term, position) => {
    if (!postings.has(term)) {
      postings.set(term, { term, field, frequency: 0, positions: [] });
    }
    const entry = postings.get(term);
    entry.frequency += 1;
    if (entry.positions.length < 64) entry.positions.push(position);
  });
  return postings;
}

/*
 * Turn a record into an indexable document. Callers pass the pieces they
 * consider searchable; this assembles the token stream and posting rows
 * ready to be persisted.
 */
function buildDocument({ module, recordId, title, subtitle, body, keywords, ownerId, status, boost }) {
  const fields = {
    title: title || '',
    subtitle: subtitle || '',
    keywords: keywords || '',
    body: body || '',
  };

  const allPostings = [];
  const allTokens = [];

  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    const postings = buildPostings(text, field);
    for (const entry of postings.values()) {
      allPostings.push({
        term: entry.term,
        field,
        frequency: entry.frequency,
        positions: entry.positions.join(','),
      });
      for (let i = 0; i < entry.frequency; i += 1) allTokens.push(entry.term);
    }
  }

  return {
    module,
    recordId,
    title: title || '(untitled)',
    subtitle: subtitle || null,
    body: body ? String(body).slice(0, 20000) : null,
    keywords: keywords || null,
    tokens: allTokens.join(' '),
    tokenCount: allTokens.length,
    ownerId: ownerId || null,
    status: status || null,
    boost: typeof boost === 'number' ? boost : 1.0,
    postings: allPostings,
  };
}

// ─── Query parsing ───────────────────────────────────────────

/*
 * Parse a user query into structured clauses.
 *
 * Supported syntax:
 *   plain words          optional terms, contribute to score
 *   "quoted phrase"      all terms must appear adjacently
 *   +required            term must be present
 *   -excluded            term must be absent
 *   module:accounts      restrict to a module
 *   owner:me             restrict to the calling user
 *   status:open          restrict by indexed status
 */
function parseQuery(input) {
  const result = {
    raw: input || '',
    terms: [],
    required: [],
    excluded: [],
    phrases: [],
    filters: {},
    isEmpty: true,
  };
  if (!input || !String(input).trim()) return result;

  const text = String(input).trim();
  const tokenPattern = /(-|\+)?(?:"([^"]*)"|(\S+))/g;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    const modifier = match[1] || '';
    const quoted = match[2];
    const bare = match[3];

    if (quoted !== undefined) {
      const phraseTerms = tokenize(quoted);
      if (phraseTerms.length === 0) continue;
      if (modifier === '-') {
        result.excluded.push(...phraseTerms);
      } else {
        result.phrases.push({ terms: phraseTerms, text: quoted });
        result.terms.push(...phraseTerms);
        if (modifier === '+') result.required.push(...phraseTerms);
      }
      continue;
    }

    if (!bare) continue;

    const fieldMatch = bare.match(/^([a-zA-Z]+):(.+)$/);
    if (fieldMatch) {
      const key = fieldMatch[1].toLowerCase();
      const value = fieldMatch[2];
      if (['module', 'owner', 'status', 'type', 'in'].includes(key)) {
        result.filters[key === 'in' ? 'module' : key] = value.toLowerCase();
        continue;
      }
    }

    const parsed = tokenize(bare);
    if (parsed.length === 0) continue;
    if (modifier === '-') result.excluded.push(...parsed);
    else if (modifier === '+') { result.required.push(...parsed); result.terms.push(...parsed); }
    else result.terms.push(...parsed);
  }

  result.terms = [...new Set(result.terms)];
  result.required = [...new Set(result.required)];
  result.excluded = [...new Set(result.excluded)];
  result.isEmpty = result.terms.length === 0
    && result.required.length === 0
    && Object.keys(result.filters).length === 0;

  return result;
}

// ─── Fuzzy matching ──────────────────────────────────────────

/*
 * Levenshtein edit distance with early termination. Used to offer a
 * "did you mean" correction when a query returns nothing.
 */
function levenshtein(a, b, maxDistance = Infinity) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const swap = previous; previous = current; current = swap;
  }
  return previous[b.length];
}

function trigrams(value) {
  const padded = `  ${normalizeText(value)} `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

/* Jaccard similarity over trigram sets, in the range 0 to 1. */
function trigramSimilarity(a, b) {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const gram of ga) if (gb.has(gram)) intersection += 1;
  return intersection / (ga.size + gb.size - intersection);
}

/*
 * Given a misspelled term and the vocabulary of indexed terms, propose
 * the closest correction. Requires both a small edit distance and a
 * reasonable trigram overlap to avoid nonsense suggestions.
 */
function suggestCorrection(term, vocabulary, options = {}) {
  const { maxDistance = 2, minSimilarity = 0.4 } = options;
  let best = null;
  let bestScore = -Infinity;

  for (const candidate of vocabulary) {
    if (candidate === term) return null;
    const distance = levenshtein(term, candidate, maxDistance);
    if (distance > maxDistance) continue;
    const similarity = trigramSimilarity(term, candidate);
    if (similarity < minSimilarity) continue;
    const score = similarity - (distance * 0.15);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

// ─── BM25 ranking ────────────────────────────────────────────

/*
 * Okapi BM25 with per-field weighting.
 *
 * idf   = ln(1 + (N - n + 0.5) / (n + 0.5))
 * score = idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len/avgLen))
 *
 * where N is the corpus size, n the number of documents containing the
 * term, f the weighted term frequency in the document, and len the
 * document length in tokens.
 */
function idf(totalDocs, docsWithTerm) {
  const numerator = totalDocs - docsWithTerm + 0.5;
  const denominator = docsWithTerm + 0.5;
  return Math.log(1 + (numerator / denominator));
}

function bm25TermScore({ termFrequency, docLength, avgDocLength, totalDocs, docsWithTerm }) {
  if (termFrequency <= 0) return 0;
  const k1 = BM25_K1;
  const b = BM25_B;
  const normalization = 1 - b + (b * (docLength / (avgDocLength || 1)));
  const tf = (termFrequency * (k1 + 1)) / (termFrequency + (k1 * normalization));
  return idf(totalDocs, docsWithTerm) * tf;
}

/*
 * Score one candidate document against a parsed query.
 *
 * `doc` carries the index row plus its postings grouped by term.
 * `stats` carries corpus level figures needed for IDF.
 *
 * Returns null when the document fails a hard constraint (a required
 * term is missing, an excluded term is present, or a phrase does not
 * actually appear adjacently).
 */
function scoreDocument(doc, query, stats) {
  const { totalDocs, avgDocLength, termDocCounts } = stats;
  const postingsByTerm = doc.postingsByTerm || new Map();

  for (const term of query.excluded) {
    if (postingsByTerm.has(term)) return null;
  }
  for (const term of query.required) {
    if (!postingsByTerm.has(term)) return null;
  }

  let matchedPhrases = 0;
  for (const phrase of query.phrases) {
    if (!phraseMatches(postingsByTerm, phrase.terms)) return null;
    matchedPhrases += 1;
  }

  let score = 0;
  let matchedTerms = 0;
  const docLength = doc.tokenCount || 1;

  for (const term of query.terms) {
    const postings = postingsByTerm.get(term);
    if (!postings) continue;
    matchedTerms += 1;

    let weightedFrequency = 0;
    for (const posting of postings) {
      const weight = FIELD_WEIGHTS[posting.field] || 1.0;
      weightedFrequency += posting.frequency * weight;
    }

    score += bm25TermScore({
      termFrequency: weightedFrequency,
      docLength,
      avgDocLength,
      totalDocs,
      docsWithTerm: termDocCounts.get(term) || 1,
    });
  }

  if (matchedTerms === 0 && matchedPhrases === 0 && query.terms.length > 0) return null;

  // Coordination: documents matching more of the query rank above
  // documents that match one term many times.
  const coordination = query.terms.length > 0
    ? 0.5 + (0.5 * (matchedTerms / query.terms.length))
    : 1;

  // Exact title equality is a strong signal that beats any term math.
  const titleExact = normalizeText(doc.title) === normalizeText(query.raw);

  let finalScore = score * coordination * (doc.boost || 1);
  if (matchedPhrases > 0) finalScore *= 1 + (0.35 * matchedPhrases);
  if (titleExact) finalScore *= 3;

  return {
    score: finalScore,
    matchedTerms,
    matchedPhrases,
    titleExact,
    coordination,
  };
}

/*
 * Verify that the phrase terms occur consecutively somewhere in the
 * document by walking the recorded position lists.
 */
function phraseMatches(postingsByTerm, terms) {
  if (terms.length === 0) return false;
  if (terms.length === 1) return postingsByTerm.has(terms[0]);

  const positionSets = terms.map((term) => {
    const postings = postingsByTerm.get(term);
    if (!postings) return null;
    const positions = new Set();
    for (const posting of postings) {
      if (!posting.positions) continue;
      for (const raw of String(posting.positions).split(',')) {
        const value = Number(raw);
        if (!Number.isNaN(value)) positions.add(value);
      }
    }
    return positions;
  });

  if (positionSets.some((set) => set === null || set.size === 0)) return false;

  for (const start of positionSets[0]) {
    let ok = true;
    for (let offset = 1; offset < positionSets.length; offset += 1) {
      if (!positionSets[offset].has(start + offset)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ─── Snippets ────────────────────────────────────────────────

/*
 * Extract the most relevant window of body text and mark the matching
 * terms. Chooses the window containing the highest density of query
 * terms rather than simply taking the head of the document.
 */
function buildSnippet(body, queryTerms, options = {}) {
  const { windowSize = 220, marker = ['<mark>', '</mark>'] } = options;
  if (!body) return '';
  const text = String(body);
  if (queryTerms.length === 0) return text.slice(0, windowSize);

  const words = text.split(/\s+/);
  const stems = new Set(queryTerms);
  const hits = [];

  words.forEach((word, index) => {
    const [token] = tokenize(word);
    if (token && stems.has(token)) hits.push(index);
  });

  if (hits.length === 0) {
    return text.length > windowSize ? `${text.slice(0, windowSize).trim()}...` : text;
  }

  // Slide a window over the hit positions to find the densest cluster.
  const approxWordsInWindow = Math.max(10, Math.round(windowSize / 6));
  let bestStart = hits[0];
  let bestCount = 0;
  for (const hit of hits) {
    const count = hits.filter((h) => h >= hit && h < hit + approxWordsInWindow).length;
    if (count > bestCount) { bestCount = count; bestStart = hit; }
  }

  const from = Math.max(0, bestStart - 6);
  const to = Math.min(words.length, from + approxWordsInWindow);
  const slice = words.slice(from, to);

  const highlighted = slice.map((word) => {
    const [token] = tokenize(word);
    return token && stems.has(token) ? `${marker[0]}${word}${marker[1]}` : word;
  });

  let snippet = highlighted.join(' ');
  if (from > 0) snippet = `...${snippet}`;
  if (to < words.length) snippet = `${snippet}...`;
  return snippet;
}

// ─── Synonym expansion ───────────────────────────────────────

/*
 * Expand query terms using a synonym table. Two way entries expand in
 * both directions; one way entries only expand from term to synonym so
 * that a narrow term does not drag in a broad one.
 */
function expandSynonyms(terms, synonymRows) {
  const expanded = new Set(terms);
  for (const term of terms) {
    for (const row of synonymRows) {
      const rowTerm = stem(normalizeText(row.term));
      const rowSynonym = stem(normalizeText(row.synonym));
      if (rowTerm === term) expanded.add(rowSynonym);
      else if (row.twoWay && rowSynonym === term) expanded.add(rowTerm);
    }
  }
  return [...expanded];
}

// ─── Facets ──────────────────────────────────────────────────

function computeFacets(results) {
  const byModule = new Map();
  const byOwner = new Map();
  const byStatus = new Map();

  for (const row of results) {
    byModule.set(row.module, (byModule.get(row.module) || 0) + 1);
    if (row.ownerId) byOwner.set(row.ownerId, (byOwner.get(row.ownerId) || 0) + 1);
    if (row.status) byStatus.set(row.status, (byStatus.get(row.status) || 0) + 1);
  }

  const toArray = (map) => [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  return {
    modules: toArray(byModule),
    owners: toArray(byOwner),
    statuses: toArray(byStatus),
  };
}

module.exports = {
  STOPWORDS,
  FIELD_WEIGHTS,
  BM25_K1,
  BM25_B,
  stem,
  measure,
  normalizeText,
  tokenize,
  buildPostings,
  buildDocument,
  parseQuery,
  levenshtein,
  trigrams,
  trigramSimilarity,
  suggestCorrection,
  idf,
  bm25TermScore,
  scoreDocument,
  phraseMatches,
  buildSnippet,
  expandSynonyms,
  computeFacets,
};
