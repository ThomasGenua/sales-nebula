const { test, expect } = require('@playwright/test');
async function login(page, path = '/app/salesOperations') {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('pilot-admin@example.com');
  await page.getByLabel(/^Password/).fill('Pilot-admin-123!');
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
  await page.goto(path);
}
async function auth(request) {
  const response = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  return { Authorization: 'Bearer ' + (await response.json()).token };
}
test('enterprise settings and pricing editor save a validated rule', async ({ page, request }, info) => {
  await login(page);
  await page.getByRole('navigation', { name: 'Sales operations' }).getByRole('button', { name: 'Enterprise configuration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Field permissions', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Module', exact: true })).toHaveValue('deals');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('enterprise-settings.png'), fullPage: true });
  await page.getByRole('navigation', { name: 'Sales operations' }).getByRole('button', { name: 'Pricing rules', exact: true }).click();
  await page.getByLabel('Rule name').fill('Browser pricing rule');
  await page.getByRole('button', { name: 'Add action', exact: true }).click();
  await page.getByLabel('Amount', { exact: true }).fill('5');
  const saved = page.waitForResponse(r => r.url().endsWith('/cpq/advanced/price-rules') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save rule', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
  const rule = await response.json();
  await page.screenshot({ path: info.outputPath('pricing-rules.png'), fullPage: true });
  await request.delete('/api/cpq/advanced/price-rules/' + rule.id, { headers: await auth(request) });
});

test('record-type choice assigns the layout and persists on a contact', async ({ page, request }) => {
  const headers = await auth(request);
  const layoutResponse = await request.post('/api/configuration/page-layouts', { headers, data: { name: 'Browser contact layout', module: 'contacts', sections: [{ label: 'Contact', fields: [{ name: 'firstName' }, { name: 'lastName', required: true }, { name: 'email', required: true }] }] } });
  expect(layoutResponse.ok(), await layoutResponse.text()).toBeTruthy();
  const layout = await layoutResponse.json();
  const typeResponse = await request.post('/api/configuration/record-types', { headers, data: { name: 'Browser enterprise contact', module: 'contacts', layoutId: layout.id, roleIds: [] } });
  expect(typeResponse.ok(), await typeResponse.text()).toBeTruthy();
  const type = await typeResponse.json();
  await login(page, '/app/contacts');
  await page.getByRole('button', { name: 'New Contacts', exact: true }).click();
  await page.getByRole('combobox', { name: 'Record type', exact: true }).selectOption(type.id);
  await page.getByLabel(/^First Name/).fill('Enterprise');
  await page.getByLabel(/^Last Name/).fill('Browser');
  await page.getByLabel(/^Email/).fill('enterprise-browser@example.com');
  const saved = page.waitForResponse(r => r.url().endsWith('/api/contacts') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
  expect((await response.json()).recordTypeId).toBe(type.id);
});

test('matrix reports render pivots and dashboards render saved reports', async ({ page, request }, info) => {
  const headers = await auth(request);
  await request.post('/api/deals', { headers, data: { name: 'Matrix browser deal', value: 123, currency: 'USD', stage: 'Proposal' } });
  const response = await request.post('/api/reports', { headers, data: { name: 'Browser matrix', module: 'deals', reportType: 'matrix', columns: [], filters: [], groupBy: ['stage','currency'], aggregations: [{ field: 'value', function: 'sum' }] } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const report = await response.json();
  const dashboardResponse = await request.post('/api/analytics/dashboards', { headers, data: { name: 'Browser revenue dashboard', layout: [{ config: { reportId: report.id } }] } });
  const dashboard = await dashboardResponse.json();
  await login(page, '/app/reports');
  await page.getByRole('button', { name: 'Browser matrix', exact: true }).click();
  await page.getByRole('button', { name: 'Run report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'stage by currency', exact: true })).toBeVisible();
  await page.getByText('Saved dashboards', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Dashboard', exact: true }).selectOption(dashboard.id);
  await page.getByRole('button', { name: 'Run dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser matrix', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('matrix-dashboard.png'), fullPage: true });
});
