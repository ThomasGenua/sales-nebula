const { execFileSync } = require('node:child_process');
const path = require('node:path');
test('real OIDC JWT and SAML signatures reject tampering, wrong audience, request swapping and replay', () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'enterpriseCrypto.cjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_ENV: 'test', JWT_SECRET: 'enterprise-crypto-fixture-only-signing-key' } });
  expect(output).toContain('signed identity fixtures passed');
});
