function databaseUrl(env = process.env) {
  if (!env.PGHOST) return env.DATABASE_URL;
  const url = new URL('postgresql://localhost');
  url.hostname = env.PGHOST;
  url.port = env.PGPORT || '5432';
  url.username = encodeURIComponent(env.PGUSER || 'salesnebula');
  url.password = encodeURIComponent(env.PGPASSWORD || '');
  url.pathname = '/' + encodeURIComponent(env.PGDATABASE || 'sales_nebula');
  url.searchParams.set('schema', 'public');
  return url.toString();
}
module.exports = { databaseUrl };
