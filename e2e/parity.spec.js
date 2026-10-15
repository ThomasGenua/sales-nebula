const { test, expect } = require('@playwright/test');

async function login(page) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('pilot-admin@example.com');
  await page.getByLabel(/^Password/).fill('Pilot-admin-123!');
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
}

test('custom object fields drive a record form and persist typed values', async ({ page, request }) => {
  const response = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  const headers = { Authorization: 'Bearer ' + (await response.json()).token };
  const created = await request.post('/api/custom-objects', { headers, data: { label: 'Browser widget', apiName: 'browser_widget__c', fields: [{ label: 'Serial', apiName: 'serial', required: true }, { label: 'Amount', apiName: 'amount', type: 'Number' }] } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const object = await created.json();
  await login(page);
  await page.goto('/app/customObjects');
  await page.getByRole('combobox', { name: 'Custom object', exact: true }).selectOption(object.id);
  await page.getByRole('button', { name: 'New record', exact: true }).click();
  await page.getByLabel('Serial').fill('BROWSER-001');
  await page.getByLabel('Amount', { exact: true }).fill('125.5');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'BROWSER-001', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '125.5', exact: true })).toBeVisible();
});

test('flow designer can save and publish a connected flow', async ({ page }) => {
  await login(page);
  await page.goto('/app/flowBuilder');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name', { exact: true }).fill('Browser flow');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browser flow · Active', exact: true })).toBeVisible();
});

test('approval designer saves a manager review process', async ({ page }) => {
  await login(page);
  await page.goto('/app/approvals');
  await page.getByText('Design approval processes', { exact: true }).click();
  await page.getByRole('button', { name: 'New process', exact: true }).click();
  await page.getByLabel('Process name').fill('Browser approval');
  await page.getByRole('button', { name: 'Save process', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browser approval', exact: true })).toBeVisible();
});
