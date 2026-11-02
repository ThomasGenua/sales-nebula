const { test, expect } = require('./fixtures');
async function login(page) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('pilot-admin@example.com');
  await page.getByLabel(/^Password/).fill('Pilot-admin-123!');
  await page.getByRole('button', { name: /^Sign In$/ }).click();
  await expect(page.locator('#main-content')).toBeVisible();
}
async function headers(request) {
  const result = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  return { Authorization: 'Bearer ' + (await result.json()).token };
}
test('setup checklist survives reload and provides an actionable pipeline and import template', async ({ page, request }, info) => {
  const auth = await headers(request);
  await request.post('/api/onboarding/preferences', { headers: auth, data: { dismissed: false } });
  await login(page);
  const setup = page.getByRole('region', { name: 'Workspace setup' });
  await setup.getByRole('listitem').filter({ hasText: 'Set up your pipeline' }).getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: 'Review your sales pipeline' });
  await expect(dialog).toContainText('Qualification → Discovery');
  await dialog.getByRole('button', { name: 'Use current pipeline' }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(setup.getByRole('listitem').filter({ hasText: 'Set up your pipeline' }).getByLabel('Completed')).toBeVisible();
  const download = await Promise.all([page.waitForEvent('download'), setup.getByRole('link', { name: 'Download contact CSV template' }).click()]);
  expect(download[0].suggestedFilename()).toBe('contacts.csv');
  await page.screenshot({ path: info.outputPath('onboarding-desktop.png'), fullPage: true });
  await setup.getByRole('button', { name: 'Hide setup' }).click();
  await page.reload();
  await expect(setup.getByRole('button', { name: 'Show setup' })).toBeVisible();
});

test('integration guide validates SMTP without sending mail and exposes a single recovery queue', async ({ page }, info) => {
  await login(page); await page.goto('/app/salesOperations');
  await page.getByRole('navigation', { name: 'Sales operations' }).getByRole('button', { name: 'Integration operations' }).click();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  const card = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Outgoing email' }) });
  await card.locator('summary').click();
  await card.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connection verified. No message' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('integration-setup-desktop.png'), fullPage: true });
});

test('mobile deal editing saves next action and quote deadlines stay readable', async ({ page, request }, info) => {
  const auth = await headers(request);
  const result = await request.post('/api/deals', { headers: auth, data: { name: 'Mobile activation deal', value: 4250, currency: 'USD', closeDate: '2030-03-10' } });
  expect(result.ok(), await result.text()).toBeTruthy(); const deal = await result.json();
  const productResponse = await request.post('/api/products', { headers: auth, data: { name: 'Mobile proposal product', sku: 'MOBILE-' + Date.now(), price: 4250 } });
  expect(productResponse.ok(), await productResponse.text()).toBeTruthy();
  const product = await productResponse.json();
  const q = await request.post('/api/quotes', { headers: auth, data: { name: 'Mobile proposal', validUntil: '2030-04-15', items: [{ productId: product.id, quantity: 1, unitPrice: 4250 }] } });
  expect(q.ok(), await q.text()).toBeTruthy(); const quote = await q.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page); await page.goto('/app/deals/' + deal.id);
  await page.getByRole('button', { name: 'Update record', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Next action', { exact: true }).fill('Confirm rollout with buyer');
  await dialog.getByLabel('Next action due', { exact: true }).fill('2030-03-09');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Record overview' })).toContainText('Confirm rollout with buyer');
  await page.screenshot({ path: info.outputPath('deal-mobile.png'), fullPage: true });
  await page.goto('/app/quotes/' + quote.id);
  await expect(page.getByRole('region', { name: 'Record overview' })).toContainText('4,250');
  await expect(page.getByRole('region', { name: 'Record overview' })).toContainText('Apr 15, 2030');
  await expect(page.locator('#main-content')).not.toContainText('2030-04-15T');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('quote-mobile.png'), fullPage: true });
});

test('provider callback removes the code and requires the MFA step before entering the app', async ({ page }) => {
  let callbacks = 0, verification = 0;
  const user = { id: 'callback-user', firstName: 'Test', lastName: 'User', email: 'test@example.com', role: { name: 'Reader', permissions: [{ module: 'deals', level: 'read' }] } };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me' || path === '/api/auth/refresh') return route.fulfill({ status: 401, json: { error: 'Signed out' } });
    if (path === '/api/oauth/callback') { callbacks++; expect(route.request().postDataJSON()).toMatchObject({ state: 'test-state', code: 'one-use-code' }); return route.fulfill({ json: { mfaRequired: true, mfaToken: 'test-challenge', devices: [{ id: 'device', type: 'totp' }] } }); }
    if (path === '/api/auth/mfa/verify') { verification++; return route.fulfill({ json: { session: 'cookie', user } }); }
    if (path === '/api/onboarding') return route.fulfill({ json: { steps: [], dismissed: true } });
    return route.fulfill({ json: { data: [], items: [], total: 0 } });
  });
  await page.goto('/oauth/callback?code=one-use-code&state=test-state');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible();
  await expect(page.locator('#main-content')).toHaveCount(0);
  await page.getByLabel(/code/i).fill('123456');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.locator('#main-content')).toBeVisible();
  expect(callbacks).toBe(1); expect(verification).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('sn_token'))).toBeNull();
});
