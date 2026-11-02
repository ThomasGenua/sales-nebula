const { test: base, expect } = require('@playwright/test');
// Every browser journey gets a clean workspace. Configuration tests must not
// leave mandatory record types or validation rules behind for unrelated cases.
const test = base.extend({
  workspace: [async ({ request }, use) => {
    const result = await request.post('/__test/reset', { headers: { 'X-Test-Reset': 'local-browser-tests' } });
    expect(result.ok(), await result.text()).toBeTruthy();
    await use();
  }, { auto: true }],
});
module.exports = { test, expect };
