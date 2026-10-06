const { databaseUrl } = require('../scripts/database-url');

test('Docker credentials containing URL punctuation reach the intended database', () => {
  const input = { PGHOST: 'postgres', PGPORT: '5432', PGUSER: 'salesnebula', PGPASSWORD: 'test-only:p@ss/%?#word', PGDATABASE: 'sales_nebula' };
  const url = new URL(databaseUrl(input));
  expect(url.hostname).toBe('postgres'); expect(url.pathname).toBe('/sales_nebula');
  expect(decodeURIComponent(url.password)).toBe(input.PGPASSWORD);
  expect(url.searchParams.get('schema')).toBe('public');
});
test('local command-line tools preserve an explicitly configured connection URL', () => {
  const url = 'postgresql://test:test@localhost/sales_nebula_test?schema=public';
  expect(databaseUrl({ DATABASE_URL: url })).toBe(url);
});
