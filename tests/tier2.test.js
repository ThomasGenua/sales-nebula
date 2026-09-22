/**
 * Tier 2 feature tests: merge field rendering, business-hours SLA math,
 * and the full-text search engine.
 *
 * Engines are tested directly. Route behaviour activates when supertest
 * and a seeded tests/setup.js are available.
 */

const M = require('../src/utils/mergeFields');
const B = require('../src/utils/businessHours');
const S = require('../src/utils/searchIndex');

const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min);

describe('Merge field rendering', () => {
  const ctx = {
    contact: { firstName: 'Ada', lastName: 'Lovelace', title: null, email: 'ada@example.com' },
    deal: { amount: 12500.5, closeDate: '2026-09-15T00:00:00Z', won: true },
    lineItems: [
      { name: 'License', quantity: 2, unitPrice: 100, total: 200 },
      { name: 'Support', quantity: 1, unitPrice: 50, total: 50 },
    ],
    discount: 0,
  };

  test('resolves a simple path', () => {
    expect(M.render('{{contact.firstName}}', ctx)).toBe('Ada');
  });

  test('returns empty string for a missing path rather than throwing', () => {
    expect(M.render('[{{a.b.c}}]', ctx)).toBe('[]');
    expect(M.render('{{nothing}}', {})).toBe('');
  });

  test('applies formatters', () => {
    expect(M.render('{{contact.lastName|upper}}', ctx)).toBe('LOVELACE');
    expect(M.render('{{deal.amount|currency:USD}}', ctx)).toBe('$12,500.50');
    expect(M.render('{{deal.closeDate|date:iso}}', ctx)).toBe('2026-09-15');
    expect(M.render('{{deal.won|yesno}}', ctx)).toBe('Yes');
  });

  test('default formatter fills an empty value', () => {
    expect(M.render('{{contact.title|default:Unknown}}', ctx)).toBe('Unknown');
    expect(M.render('{{contact.firstName|default:Unknown}}', ctx)).toBe('Ada');
  });

  test('chains formatters left to right', () => {
    expect(M.render('{{contact.firstName|upper|truncate:2}}', ctx)).toBe('AD...');
  });

  test('expands each blocks with loop counters', () => {
    expect(M.render('{{#each lineItems}}{{@number}}:{{name}} {{/each}}', ctx)).toBe('1:License 2:Support ');
  });

  test('renders nothing for an empty or missing list', () => {
    expect(M.render('{{#each missing}}X{{/each}}', ctx)).toBe('');
    expect(M.render('{{#each empty}}X{{/each}}', { empty: [] })).toBe('');
  });

  test('treats zero and empty arrays as falsy in conditionals', () => {
    expect(M.render('{{#if deal.won}}WON{{/if}}', ctx)).toBe('WON');
    expect(M.render('{{#if discount}}D{{/if}}', ctx)).toBe('');
    expect(M.render('{{#if empty}}X{{/if}}', { empty: [] })).toBe('');
  });

  test('supports else and unless', () => {
    expect(M.render('{{#if discount}}D{{else}}NONE{{/if}}', ctx)).toBe('NONE');
    expect(M.render('{{#unless discount}}NODISC{{/unless}}', ctx)).toBe('NODISC');
  });

  test('escapes HTML by default and allows opting out', () => {
    expect(M.render('{{x}}', { x: '<script>' })).toBe('&lt;script&gt;');
    expect(M.render('{{x}}', { x: '<b>' }, { escape: false })).toBe('<b>');
  });

  test('extracts referenced merge fields', () => {
    expect(M.extractMergeFields('{{a.b}} {{#each list}}{{name}}{{/each}} {{c|upper}}')).toEqual(['a.b', 'c', 'list', 'name']);
  });

  test('flags unbalanced blocks', () => {
    const result = M.validateTemplate('{{#each x}}{{name}}');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('warns about an unknown formatter without failing', () => {
    const result = M.validateTemplate('{{a|nonsense}}');
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('computes line item totals in the build context', () => {
    const built = M.buildContext('quotes', { id: 'q1', quoteNumber: 'Q-1' }, { lineItems: ctx.lineItems });
    expect(built.totals.subtotal).toBe(250);
    expect(built.totals.itemCount).toBe(2);
    expect(built.quote.quoteNumber).toBe('Q-1');
  });

  test('builds a complete printable document', () => {
    const doc = M.buildDocument({ name: 'T', bodyHtml: '<p>{{contact.firstName}}</p>', pageSize: 'A4' }, ctx);
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(doc).toContain('<p>Ada</p>');
    expect(doc).toContain('@page { size: A4 portrait');
  });

  test('every starter template is syntactically valid', () => {
    for (const t of Object.values(M.STARTER_TEMPLATES)) {
      expect(M.validateTemplate(t.bodyHtml).valid).toBe(true);
    }
  });
});

describe('Business hours arithmetic', () => {
  test('recognizes open and closed times', () => {
    expect(B.isWithinBusinessHours(d(2026, 8, 10, 10))).toBe(true);
    expect(B.isWithinBusinessHours(d(2026, 8, 10, 8))).toBe(false);
    expect(B.isWithinBusinessHours(d(2026, 8, 10, 18))).toBe(false);
    expect(B.isWithinBusinessHours(d(2026, 8, 15, 12))).toBe(false);
  });

  test('counts only open minutes', () => {
    expect(B.businessMinutesBetween(d(2026, 8, 10, 9), d(2026, 8, 10, 17))).toBe(480);
    expect(B.businessMinutesBetween(d(2026, 8, 10, 17), d(2026, 8, 11, 9))).toBe(0);
    expect(B.businessMinutesBetween(d(2026, 8, 10, 16), d(2026, 8, 11, 10))).toBe(120);
  });

  test('skips the weekend', () => {
    expect(B.businessMinutesBetween(d(2026, 8, 14, 16), d(2026, 8, 17, 10))).toBe(120);
  });

  test('measures a full working week', () => {
    expect(B.businessMinutesBetween(d(2026, 8, 10, 9), d(2026, 8, 14, 17))).toBe(2400);
  });

  test('returns zero when the end precedes the start', () => {
    expect(B.businessMinutesBetween(d(2026, 8, 12), d(2026, 8, 10))).toBe(0);
  });

  test('adds business time within a single day', () => {
    const due = B.addBusinessHours(d(2026, 8, 10, 10), 4);
    expect(due.getDate()).toBe(10);
    expect(due.getHours()).toBe(14);
  });

  test('rolls a Friday afternoon target into Monday', () => {
    // Fri 4pm has one open hour left, so the remaining three land Monday at noon
    const due = B.addBusinessHours(d(2026, 8, 14, 16), 4);
    expect(due.getDay()).toBe(1);
    expect(due.getHours()).toBe(12);
  });

  test('rolls a start before opening to the open bell', () => {
    expect(B.addBusinessHours(d(2026, 8, 10, 7), 1).getHours()).toBe(10);
  });

  test('add and measure are mutually consistent', () => {
    for (const [start, minutes] of [[d(2026, 8, 14, 16), 240], [d(2026, 8, 10, 10), 240], [d(2026, 8, 13, 15), 960]]) {
      const due = B.addBusinessMinutes(start, minutes);
      expect(Math.abs(B.businessMinutesBetween(start, due) - minutes)).toBeLessThan(0.01);
    }
  });

  test('excludes holidays from both directions', () => {
    const config = { holidays: ['2026-08-11'] };
    expect(B.businessMinutesBetween(d(2026, 8, 10, 16), d(2026, 8, 12, 10), config)).toBe(120);
    const due = B.addBusinessHours(d(2026, 8, 10, 16), 4, config);
    expect(due.getDate()).toBe(12);
  });

  test('honours a custom round-the-clock schedule', () => {
    const always = { schedule: [0, 1, 2, 3, 4, 5, 6].map(x => ({ dayOfWeek: x, openMinute: 0, closeMinute: 1440, closed: false })) };
    expect(B.businessMinutesBetween(d(2026, 8, 15, 0), d(2026, 8, 16, 0), always)).toBe(1440);
  });

  test('finds the next open moment', () => {
    const next = B.nextBusinessOpen(d(2026, 8, 15, 12));
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(9);
    expect(B.nextBusinessOpen(d(2026, 8, 10, 10)).getHours()).toBe(10);
  });
});

describe('SLA evaluation', () => {
  test('reports on-track below the warning threshold', () => {
    const sla = B.calculateSla({ startedAt: d(2026, 8, 10, 9), targetMinutes: 240, now: d(2026, 8, 10, 11) });
    expect(sla.status).toBe('OnTrack');
    expect(sla.percentUsed).toBe(50);
  });

  test('flags at-risk once the threshold is crossed', () => {
    expect(B.calculateSla({ startedAt: d(2026, 8, 10, 9), targetMinutes: 240, now: d(2026, 8, 10, 12, 30) }).status).toBe('AtRisk');
  });

  test('reports a breach with the overdue amount', () => {
    const sla = B.calculateSla({ startedAt: d(2026, 8, 10, 9), targetMinutes: 240, now: d(2026, 8, 10, 15) });
    expect(sla.status).toBe('Breached');
    expect(sla.overdueByMinutes).toBe(120);
  });

  test('reports met when completed inside the target', () => {
    expect(B.calculateSla({ startedAt: d(2026, 8, 10, 9), targetMinutes: 240, completedAt: d(2026, 8, 10, 11), now: d(2026, 8, 20) }).status).toBe('Met');
  });

  test('subtracts paused windows from elapsed time', () => {
    const sla = B.calculateSla({
      startedAt: d(2026, 8, 10, 9), targetMinutes: 240, now: d(2026, 8, 10, 15),
      pauses: [{ start: d(2026, 8, 10, 10), end: d(2026, 8, 10, 13) }],
    });
    expect(sla.elapsedMinutes).toBe(180);
    expect(sla.breached).toBe(false);
  });

  test('is not applicable without a target', () => {
    expect(B.calculateSla({ startedAt: d(2026, 8, 10) }).applicable).toBe(false);
  });

  test('places a Friday deadline on the next open day', () => {
    const sla = B.calculateSla({ startedAt: d(2026, 8, 14, 16), targetMinutes: 240, now: d(2026, 8, 14, 17) });
    expect(sla.dueAt.getDay()).toBe(1);
  });

  test('formats durations readably', () => {
    expect(B.formatDuration(45)).toBe('45m');
    expect(B.formatDuration(150)).toBe('2h 30m');
    expect(B.formatDuration(1500)).toBe('1d 1h');
  });

  test('provides priority targets with first response inside resolution', () => {
    for (const priority of ['Critical', 'High', 'Medium', 'Low']) {
      const t = B.targetsForPriority(priority);
      expect(t.firstResponse).toBeLessThan(t.resolution);
    }
  });
});

describe('Search tokenization and indexing', () => {
  test('drops stop words and folds accents', () => {
    expect(S.tokenize('the quick brown fox')).not.toContain('the');
    expect(S.tokenize('Montreal')[0]).toBe('montreal');
  });

  test('preserves structured identifiers users search literally', () => {
    expect(S.tokenize('contact ada@example.com now')).toContain('ada@example.com');
    expect(S.tokenize('call +1 (416) 555-1234')).toContain('14165551234');
    expect(S.tokenize('see CASE-1042 please')).toContain('case-1042');
  });

  test('stems conservatively', () => {
    expect(S.stem('contracts')).toBe('contract');
    expect(S.stem('companies')).toBe('company');
    expect(S.stem('running')).toBe('run');
    expect(S.stem('business')).toBe('business');
    expect(S.stem('is')).toBe('is');
  });

  test('builds postings with per-field separation', () => {
    const entry = S.buildIndexEntry({ module: 'accounts', recordId: 'a1', title: 'Acme Corporation', subtitle: 'Manufacturing', body: 'Leading widget manufacturer' });
    expect(entry.postings.length).toBeGreaterThan(0);
    expect(entry.postings.some(p => p.field === 'title')).toBe(true);
    expect(entry.tokenCount).toBeGreaterThan(0);
  });

  test('projects records per module and rejects untitled ones', () => {
    const proj = S.projectRecord('contacts', { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', title: 'Engineer' });
    expect(proj.title).toBe('Ada Lovelace');
    expect(proj.subtitle).toBe('Engineer');
    expect(S.projectRecord('accounts', { id: 'a' })).toBeNull();
    expect(S.projectRecord('unknown-module', { id: 'x' })).toBeNull();
  });
});

describe('Search query parsing and ranking', () => {
  test('parses phrases, exclusions, requirements, filters, and prefixes', () => {
    const q = S.parseQuery('acme "annual report" -draft +signed status:Open prefix*');
    expect(q.phrases[0].text).toBe('annual report');
    expect(q.excluded.length).toBeGreaterThan(0);
    expect(q.required.length).toBeGreaterThan(0);
    expect(q.filters.status).toBe('Open');
    expect(q.prefixes).toContain('prefix');
  });

  test('ranks a title match above a body match', () => {
    const docs = [
      { recordId: 'd1', title: 'Widget', tokenCount: 20, boost: 1, postings: [{ term: 'widget', field: 'title', frequency: 1, positions: '0' }] },
      { recordId: 'd2', title: 'Other', tokenCount: 20, boost: 1, postings: [{ term: 'widget', field: 'body', frequency: 1, positions: '5' }] },
    ];
    const ranked = S.rankResults(docs, S.parseQuery('widget'), { totalDocs: 100, docFrequencies: { widget: 2 } });
    expect(ranked[0].recordId).toBe('d1');
  });

  test('drops documents containing an excluded term', () => {
    const docs = [{ recordId: 'x', title: 'A', tokenCount: 10, postings: [{ term: 'widget', field: 'body', frequency: 1 }, { term: 'draft', field: 'body', frequency: 1 }] }];
    expect(S.rankResults(docs, S.parseQuery('widget -draft'), { totalDocs: 10 })).toHaveLength(0);
  });

  test('drops documents missing a required term', () => {
    const docs = [{ recordId: 'y', title: 'B', tokenCount: 10, postings: [{ term: 'widget', field: 'body', frequency: 1 }] }];
    expect(S.rankResults(docs, S.parseQuery('widget +signed'), { totalDocs: 10 })).toHaveLength(0);
  });

  test('verifies phrase order by position', () => {
    expect(S.matchesPhrase({ annual: { positions: [3] }, report: { positions: [4] } }, ['annual', 'report'])).toBe(true);
    expect(S.matchesPhrase({ annual: { positions: [9] }, report: { positions: [4] } }, ['annual', 'report'])).toBe(false);
  });

  test('highlights and truncates snippets', () => {
    expect(S.buildSnippet('The quarterly widget report', ['widget'])).toContain('<mark>widget</mark>');
    expect(S.buildSnippet('x'.repeat(500), ['x']).length).toBeLessThan(250);
  });

  test('measures edit distance and respects the bound', () => {
    expect(S.editDistance('widget', 'widgit')).toBe(1);
    expect(S.editDistance('kitten', 'sitting')).toBe(3);
    expect(S.editDistance('a', 'zzzzzzzzzz', 2)).toBe(3);
  });

  test('suggests corrections from a vocabulary', () => {
    expect(S.suggestCorrections('widgit', ['widget', 'gadget', 'budget'])).toContain('widget');
  });

  test('expands synonyms in both directions when configured', () => {
    const table = [{ term: 'car', synonym: 'automobile', twoWay: true }];
    expect(S.expandSynonyms(['car'], table)).toContain('automobile');
    expect(S.expandSynonyms(['automobile'], table)).toContain('car');
  });
});

// The route tests below were gated on `app` being truthy at module-evaluation
// time, but `app` is only assigned once setup() has run, and ./setup exports
// setup/teardown rather than an app and a token. So the guard was always false
// and every block here was skipped — they had never once run. They use the same
// lifecycle as every other suite now.
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser } = require('./setup');

let app, prisma, token;

beforeAll(async () => {
  ({ prisma, app } = await setup());
  await cleanDatabase();
  const role = await createTestRole('Admin');
  // A seeded installation has a Sales Rep role, and the signup and invite
  // endpoints correctly refuse to guess one when it is absent.
  await createTestRole('Sales Rep');
  const auth = await createTestUser({ email: `api-${Date.now()}@test.com`, roleId: role.id });
  token = auth.token;
});

afterAll(async () => { await teardown(); });

const describeApi = describe;

describeApi('PDF templates API', () => {
  let templateId;

  test('rejects a template with no module', async () => {
    const res = await request(app).post('/api/pdf-templates').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', bodyHtml: '<p>hi</p>' });
    expect(res.status).toBe(400);
  });

  test('rejects a template with broken syntax', async () => {
    const res = await request(app).post('/api/pdf-templates').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Broken', module: 'quotes', bodyHtml: '{{#each items}}{{name}}' });
    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('creates a valid template and reports its merge fields', async () => {
    const res = await request(app).post('/api/pdf-templates').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Quote Doc', module: 'quotes', bodyHtml: '<h1>{{quote.quoteNumber}}</h1>{{#each lineItems}}<p>{{name}}</p>{{/each}}' });
    expect(res.status).toBe(201);
    expect(res.body.mergeFields).toContain('quote.quoteNumber');
    templateId = res.body.id;
  });

  test('validates a template body without saving it', async () => {
    const res = await request(app).post('/api/pdf-templates/validate').set('Authorization', `Bearer ${token}`)
      .send({ bodyHtml: '{{#if a}}{{b}}{{/if}}' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('lists available merge fields for a module', async () => {
    const res = await request(app).get('/api/pdf-templates/fields/quotes').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.groups)).toBe(true);
    expect(res.body.formatters).toContain('currency');
  });

  test('previews a template as HTML', async () => {
    const res = await request(app).post(`/api/pdf-templates/${templateId}/preview`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!DOCTYPE html>');
  });

  test('requires authentication', async () => {
    expect((await request(app).get('/api/pdf-templates')).status).toBe(401);
  });
});

describeApi('Studio API', () => {
  let fieldId, picklistId;

  test('rejects an unsupported field type', async () => {
    const res = await request(app).post('/api/studio/fields').set('Authorization', `Bearer ${token}`)
      .send({ module: 'contacts', label: 'Test', fieldType: 'hologram' });
    expect(res.status).toBe(400);
  });

  test('rejects a reserved field name', async () => {
    const res = await request(app).post('/api/studio/fields').set('Authorization', `Bearer ${token}`)
      .send({ module: 'contacts', label: 'id', fieldType: 'text' });
    expect(res.status).toBe(400);
  });

  test('creates a custom field with a slugified name', async () => {
    const res = await request(app).post('/api/studio/fields').set('Authorization', `Bearer ${token}`)
      .send({ module: 'contacts', label: `Contract Tier ${Date.now()}`, fieldType: 'text', maxLength: 50 });
    expect(res.status).toBe(201);
    expect(res.body.name).toMatch(/^contract_tier/);
    fieldId = res.body.id;
  });

  test('rejects a duplicate field on the same module', async () => {
    const label = `Dupe Field ${Date.now()}`;
    await request(app).post('/api/studio/fields').set('Authorization', `Bearer ${token}`).send({ module: 'leads', label, fieldType: 'text' });
    const res = await request(app).post('/api/studio/fields').set('Authorization', `Bearer ${token}`).send({ module: 'leads', label, fieldType: 'text' });
    expect(res.status).toBe(409);
  });

  test('requires a picklist for picklist fields', async () => {
    const res = await request(app).post('/api/studio/fields').set('Authorization', `Bearer ${token}`)
      .send({ module: 'deals', label: 'Region', fieldType: 'picklist' });
    expect(res.status).toBe(400);
  });

  test('creates a picklist with values', async () => {
    const res = await request(app).post('/api/studio/picklists').set('Authorization', `Bearer ${token}`)
      .send({ label: `Regions ${Date.now()}`, values: ['EMEA', 'AMER', 'APAC'] });
    expect(res.status).toBe(201);
    expect(res.body.values.length).toBe(3);
    picklistId = res.body.id;
  });

  test('rejects a duplicate picklist value', async () => {
    await request(app).post(`/api/studio/picklists/${picklistId}/values`).set('Authorization', `Bearer ${token}`).send({ value: 'LATAM' });
    const res = await request(app).post(`/api/studio/picklists/${picklistId}/values`).set('Authorization', `Bearer ${token}`).send({ value: 'LATAM' });
    expect(res.status).toBe(409);
  });

  test('rejects a validation rule with an unknown operator', async () => {
    const res = await request(app).post('/api/studio/rules').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad', module: 'deals', errorMessage: 'no', conditions: [{ field: 'amount', operator: 'roughly', value: 5 }] });
    expect(res.status).toBe(400);
  });

  test('evaluates rules against a candidate record', async () => {
    await request(app).post('/api/studio/rules').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Discount cap', module: 'deals', errorMessage: 'Discount above 50 percent needs approval', conditions: [{ field: 'discount', operator: 'greaterThan', value: 50 }] });
    const res = await request(app).post('/api/studio/rules/deals/evaluate').set('Authorization', `Bearer ${token}`)
      .send({ record: { discount: 75 } });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.violations.length).toBeGreaterThan(0);
  });

  test('passes a record that satisfies every rule', async () => {
    const res = await request(app).post('/api/studio/rules/deals/evaluate').set('Authorization', `Bearer ${token}`)
      .send({ record: { discount: 10 } });
    expect(res.body.valid).toBe(true);
  });
});

describeApi('SLA API', () => {
  test('computes business minutes between two timestamps', async () => {
    const res = await request(app).post('/api/sla/calculate').set('Authorization', `Bearer ${token}`)
      .send({ start: d(2026, 8, 10, 9), end: d(2026, 8, 10, 17) });
    expect(res.status).toBe(200);
    expect(res.body.businessMinutes).toBe(480);
  });

  test('rejects a calculation with no end or target', async () => {
    const res = await request(app).post('/api/sla/calculate').set('Authorization', `Bearer ${token}`).send({ start: d(2026, 8, 10, 9) });
    expect(res.status).toBe(400);
  });

  test('computes a deadline that respects closed hours', async () => {
    const res = await request(app).post('/api/sla/deadline').set('Authorization', `Bearer ${token}`)
      .send({ start: d(2026, 8, 14, 16), hours: 4 });
    expect(res.status).toBe(200);
    expect(new Date(res.body.dueAt).getDay()).toBe(1);
  });

  test('rejects a profile where closing precedes opening', async () => {
    const res = await request(app).post('/api/sla/profiles').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Broken', schedule: [{ dayOfWeek: 1, openMinute: 1020, closeMinute: 540, closed: false }] });
    expect(res.status).toBe(400);
  });

  test('rejects targets where first response exceeds resolution', async () => {
    const res = await request(app).put('/api/sla/targets').set('Authorization', `Bearer ${token}`)
      .send({ targets: { High: { firstResponse: 500, resolution: 100 } } });
    expect(res.status).toBe(400);
  });

  test('returns default targets by priority', async () => {
    const res = await request(app).get('/api/sla/targets').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describeApi('Favorites API', () => {
  const recordId = `rec-${Date.now()}`;

  test('rejects an unsupported module', async () => {
    const res = await request(app).post('/api/favorites').set('Authorization', `Bearer ${token}`)
      .send({ module: 'nonsense', recordId });
    expect(res.status).toBe(400);
  });

  test('adds a favorite', async () => {
    const res = await request(app).post('/api/favorites').set('Authorization', `Bearer ${token}`)
      .send({ module: 'accounts', recordId, recordName: 'Test Account' });
    expect(res.status).toBe(201);
  });

  test('rejects a duplicate favorite', async () => {
    const res = await request(app).post('/api/favorites').set('Authorization', `Bearer ${token}`)
      .send({ module: 'accounts', recordId });
    expect(res.status).toBe(409);
  });

  test('toggles a favorite off then on', async () => {
    const off = await request(app).post('/api/favorites/toggle').set('Authorization', `Bearer ${token}`).send({ module: 'accounts', recordId });
    expect(off.body.favorited).toBe(false);
    const on = await request(app).post('/api/favorites/toggle').set('Authorization', `Bearer ${token}`).send({ module: 'accounts', recordId });
    expect(on.body.favorited).toBe(true);
  });

  test('bulk-checks membership', async () => {
    const res = await request(app).post('/api/favorites/check').set('Authorization', `Bearer ${token}`)
      .send({ module: 'accounts', recordIds: [recordId, 'not-a-favorite'] });
    expect(res.body[recordId]).toBe(true);
    expect(res.body['not-a-favorite']).toBe(false);
  });

  test('tracks a view and returns it in recent', async () => {
    await request(app).post('/api/favorites/track').set('Authorization', `Bearer ${token}`)
      .send({ module: 'deals', recordId: 'deal-1', recordName: 'Test Deal' });
    const res = await request(app).get('/api/favorites/recent').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.recent.some(r => r.recordId === 'deal-1')).toBe(true);
  });
});

describeApi('Search API', () => {
  test('rejects a query that is too short', async () => {
    const res = await request(app).get('/api/search-index?q=a').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('returns a structured response for a valid query', async () => {
    const res = await request(app).get('/api/search-index?q=test').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(res.body).toHaveProperty('durationMs');
  });

  test('handles a stop-word-only query gracefully', async () => {
    const res = await request(app).get('/api/search-index?q=the%20and').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('rejects a self-referential synonym', async () => {
    const res = await request(app).post('/api/search-index/synonyms').set('Authorization', `Bearer ${token}`)
      .send({ term: 'widget', synonym: 'widgets' });
    expect(res.status).toBe(400);
  });

  test('reports index health', async () => {
    const res = await request(app).get('/api/search-index/health').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.coverage)).toBe(true);
  });
});

describeApi('Prospects API', () => {
  let prospectId;

  test('rejects a prospect with no last name', async () => {
    const res = await request(app).post('/api/prospects').set('Authorization', `Bearer ${token}`).send({ firstName: 'Nameless' });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid email', async () => {
    const res = await request(app).post('/api/prospects').set('Authorization', `Bearer ${token}`)
      .send({ lastName: 'Test', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('creates a prospect and scores it', async () => {
    const res = await request(app).post('/api/prospects').set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Grace', lastName: 'Hopper', email: `grace${Date.now()}@example.com`, accountName: 'Navy', title: 'Rear Admiral' });
    expect(res.status).toBe(201);
    expect(res.body.score).toBeGreaterThan(0);
    prospectId = res.body.id;
  });

  test('rejects a duplicate email', async () => {
    const email = `dupe${Date.now()}@example.com`;
    await request(app).post('/api/prospects').set('Authorization', `Bearer ${token}`).send({ lastName: 'One', email });
    const res = await request(app).post('/api/prospects').set('Authorization', `Bearer ${token}`).send({ lastName: 'Two', email });
    expect(res.status).toBe(409);
  });

  test('rejects an oversized import', async () => {
    const res = await request(app).post('/api/prospects/import').set('Authorization', `Bearer ${token}`)
      .send({ prospects: Array.from({ length: 5001 }, (_, i) => ({ lastName: `P${i}` })) });
    expect(res.status).toBe(400);
  });

  test('converts a prospect to a lead', async () => {
    const res = await request(app).post(`/api/prospects/${prospectId}/convert`).set('Authorization', `Bearer ${token}`).send({ target: 'lead' });
    expect(res.status).toBe(201);
    expect(res.body.target).toBe('lead');
  });

  test('refuses to convert the same prospect twice', async () => {
    const res = await request(app).post(`/api/prospects/${prospectId}/convert`).set('Authorization', `Bearer ${token}`).send({ target: 'lead' });
    expect(res.status).toBe(409);
  });

  test('refuses to merge a record into itself', async () => {
    const res = await request(app).post(`/api/prospects/${prospectId}/merge`).set('Authorization', `Bearer ${token}`)
      .send({ duplicateIds: [prospectId] });
    expect(res.status).toBe(400);
  });
});

describeApi('Bugs API', () => {
  let bugId;

  test('rejects a bug with no title', async () => {
    const res = await request(app).post('/api/bugs').set('Authorization', `Bearer ${token}`).send({ description: 'no title' });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid severity', async () => {
    const res = await request(app).post('/api/bugs').set('Authorization', `Bearer ${token}`)
      .send({ title: 'Test', severity: 'Catastrophic' });
    expect(res.status).toBe(400);
  });

  test('creates a bug with a sequential number', async () => {
    const res = await request(app).post('/api/bugs').set('Authorization', `Bearer ${token}`)
      .send({ title: 'Login fails on Safari', severity: 'Major', priority: 'High', component: 'Auth' });
    expect(res.status).toBe(201);
    expect(res.body.bugNumber).toMatch(/^BUG-\d{5}$/);
    bugId = res.body.id;
  });

  test('requires a target when marking a duplicate', async () => {
    const res = await request(app).put(`/api/bugs/${bugId}`).set('Authorization', `Bearer ${token}`).send({ status: 'Duplicate' });
    expect(res.status).toBe(400);
  });

  test('refuses to mark a bug a duplicate of itself', async () => {
    const res = await request(app).put(`/api/bugs/${bugId}`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'Duplicate', duplicateOfId: bugId });
    expect(res.status).toBe(400);
  });

  test('stamps fixedAt on transition to Fixed', async () => {
    const res = await request(app).put(`/api/bugs/${bugId}`).set('Authorization', `Bearer ${token}`).send({ status: 'Fixed' });
    expect(res.status).toBe(200);
    expect(res.body.fixedAt).toBeTruthy();
  });

  test('counts a reopen when moving back to an open status', async () => {
    await request(app).put(`/api/bugs/${bugId}`).set('Authorization', `Bearer ${token}`).send({ status: 'Closed' });
    const res = await request(app).put(`/api/bugs/${bugId}`).set('Authorization', `Bearer ${token}`).send({ status: 'InProgress' });
    expect(res.body.reopenCount).toBe(1);
  });

  test('rejects an empty comment', async () => {
    const res = await request(app).post(`/api/bugs/${bugId}/comments`).set('Authorization', `Bearer ${token}`).send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  test('returns a weighted triage queue', async () => {
    const res = await request(app).get('/api/bugs/analytics/triage').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.queue)).toBe(true);
  });
});

describeApi('Inbound email API', () => {
  test('rejects an account with no password', async () => {
    const res = await request(app).post('/api/inbound-email/accounts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Support', host: 'imap.example.com', username: 'support@example.com' });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown protocol', async () => {
    const res = await request(app).post('/api/inbound-email/accounts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', host: 'h', username: 'u', password: 'p', protocol: 'smtp' });
    expect(res.status).toBe(400);
  });

  test('never returns the stored password', async () => {
    const created = await request(app).post('/api/inbound-email/accounts').set('Authorization', `Bearer ${token}`)
      .send({ name: `Support ${Date.now()}`, host: 'imap.example.com', username: 'support@example.com', password: 'secret123' });
    expect(created.status).toBe(201);
    expect(created.body.password).toBeUndefined();
    expect(created.body.passwordSet).toBe(true);
  });

  test('previews routing rules against a sample message', async () => {
    const res = await request(app).post('/api/inbound-email/rules/test').set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Re: [Case #1234] Login problem', from: 'user@example.com', body: 'Still broken' });
    expect(res.status).toBe(200);
    expect(res.body.derived.caseRef).toBe('1234');
    expect(res.body.derived.normalizedSubject).toBe('Login problem');
  });
});

describeApi('Maps API', () => {
  test('rejects an invalid coordinate', async () => {
    const res = await request(app).post('/api/maps/markers').set('Authorization', `Bearer ${token}`)
      .send({ module: 'accounts', recordId: 'a1', label: 'Test', latitude: 200, longitude: 0 });
    expect(res.status).toBe(400);
  });

  test('rejects a polygon with fewer than three points', async () => {
    const res = await request(app).post('/api/maps/areas').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad', polygon: [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }] });
    expect(res.status).toBe(400);
  });

  test('creates a circular area and derives its bounds', async () => {
    const res = await request(app).post('/api/maps/areas').set('Authorization', `Bearer ${token}`)
      .send({ name: `Toronto ${Date.now()}`, shape: 'circle', centerLat: 43.6532, centerLng: -79.3832, radiusKm: 25 });
    expect(res.status).toBe(201);
    expect(res.body.areaSqKm).toBeGreaterThan(0);
    expect(res.body.minLat).toBeLessThan(43.6532);
  });

  test('rejects a nearby search without coordinates', async () => {
    const res = await request(app).get('/api/maps/nearby').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('rejects a route with fewer than two stops', async () => {
    const res = await request(app).post('/api/maps/route').set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ lat: 43.6, lng: -79.3 }] });
    expect(res.status).toBe(400);
  });
});
