const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', ...args], {
  stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
