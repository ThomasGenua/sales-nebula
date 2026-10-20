const { test, expect } = require('@playwright/test');
async function login(page) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('pilot-admin@example.com');
  await page.getByLabel(/^Password/).fill('Pilot-admin-123!');
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
  await page.goto('/app/salesOperations');
  await expect(page.getByRole('heading', { name: 'Sales Operations', exact: true })).toBeVisible();
}
async function auth(request) {
  const response = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  return { Authorization: 'Bearer ' + (await response.json()).token };
}
test('daily workspace and operations tabs load without API errors', async ({ page }, testInfo) => {
  const failures = [];
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) failures.push(`${r.status()} ${r.url()}`); });
  await login(page);
  await expect(page.getByRole('heading', { name: 'Emails awaiting your reply' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('daily-workspace.png'), fullPage: true });
  for (const name of ['Pipeline changes', 'Data quality', 'Integration operations', 'Renewals']) {
    await page.getByRole('navigation', { name: 'Sales operations' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('status', { name: 'Loading…' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  expect(failures).toEqual([]);
});

test('account 360 creates expansion and renewal queue creates a linked opportunity', async ({ page, request }, testInfo) => {
  const headers = await auth(request);
  const accountResponse = await request.post('/api/accounts', { headers, data: { name: 'Browser renewal customer' } });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const account = await accountResponse.json();
  const contractResponse = await request.post('/api/contracts', { headers, data: { name: 'Browser annual plan', accountId: account.id, startDate: '2025-01-01', endDate: new Date().toISOString(), status: 'Activated', value: 500 } });
  expect(contractResponse.ok(), await contractResponse.text()).toBeTruthy();
  await login(page);
  await page.getByRole('button', { name: 'Account 360', exact: true }).click();
  await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(account.id);
  await page.getByLabel('Expansion value').fill('250');
  await page.getByLabel('Expansion close date').fill('2031-03-01');
  await expect(page.getByRole('combobox', { name: 'Expansion currency' })).toHaveValue('USD');
  await page.getByRole('button', { name: 'Create expansion opportunity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browser renewal customer — Expansion', exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('account-360.png'), fullPage: true });
  await page.getByRole('button', { name: 'Renewals', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Opportunity currency' })).toHaveValue('USD');
  await page.getByRole('button', { name: 'Create renewal opportunity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browser annual plan — Renewal · Qualification', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create renewal opportunity', exact: true })).toHaveCount(0);
});
test('coaching saves qualification and shows pipeline field changes', async ({ page, request }) => {
  const headers = await auth(request);
  const response = await request.post('/api/deals', { headers, data: { name: 'Operations browser deal', value: 100, stage: 'Qualification' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const deal = await response.json();
  await login(page);
  await page.getByRole('button', { name: 'Deal coaching', exact: true }).click();
  await page.getByRole('combobox', { name: 'Deal', exact: true }).selectOption(deal.id);
  await page.getByLabel('Business need confirmed').check();
  await page.getByLabel('Next step', { exact: true }).fill('Schedule demonstration');
  await page.getByRole('combobox', { name: 'Stage', exact: true }).selectOption('Discovery');
  const saved = page.waitForResponse(r => r.url().endsWith(`/api/deals/${deal.id}`) && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save deal coaching' }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByLabel('Next step', { exact: true })).toHaveValue('Schedule demonstration');
  await page.getByRole('button', { name: 'Pipeline changes', exact: true }).click();
  await expect(page.getByText('stage: Qualification → Discovery')).toBeVisible();
});
test('configuration preview applies a revision and loads its previous version', async ({ page, request }) => {
  const headers = await auth(request);
  const exported = await request.get('/api/configuration-packages/export', { headers });
  const { bundle } = await exported.json();
  bundle.stageRequirements = { Negotiation: ['need'] };
  await login(page);
  await page.getByRole('button', { name: 'Configuration versions', exact: true }).click();
  await page.getByLabel('Configuration package JSON').fill(JSON.stringify(bundle));
  await page.getByRole('button', { name: 'Validate and preview' }).click();
  await expect(page.getByText('UPDATE · stageRequirements · Deal stage requirements')).toBeVisible();
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByText('Configuration applied and previous version saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Load previous version' }).first().click();
  await page.getByRole('button', { name: 'Validate and preview' }).click();
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByText('Configuration applied and previous version saved.')).toBeVisible();
});
