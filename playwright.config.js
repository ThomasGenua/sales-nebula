const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:7545', trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1440, height: 1000 } },
  reporter: [['list']],
  webServer: {
    command: 'node e2e/server.js', url: 'http://127.0.0.1:7545/api/health',
    reuseExistingServer: false, timeout: 90000,
    env: { NODE_ENV: 'test', JWT_SECRET: 'browser-tests-only-not-a-secret', PORT: '7545', FRONTEND_URL: 'http://127.0.0.1:7545' },
  },
});
