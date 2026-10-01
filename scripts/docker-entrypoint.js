// Build DATABASE_URL with encoded credentials; punctuation in a password must
// not change the host, database or query parameters.
const { spawn } = require('child_process');
const { databaseUrl } = require('./database-url');
const configuredUrl = databaseUrl();
if (configuredUrl) process.env.DATABASE_URL = configuredUrl;
const args = process.argv.slice(2);
if (!args.length) throw new Error('A command is required');
const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', err => { console.error(err.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
