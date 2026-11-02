const { defineConfig } = require('@playwright/test');

// The public surface has no database dependency. Requests are intercepted in
// the form tests; this server never sends mail or creates an access request.
module.exports = defineConfig({
  testDir: './e2e',
  testMatch: 'landing.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  outputDir: 'test-results/landing',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:7548',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm --prefix frontend run preview -- --host 127.0.0.1 --port 7548',
    url: 'http://127.0.0.1:7548',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
