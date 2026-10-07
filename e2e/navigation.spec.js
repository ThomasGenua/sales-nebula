const { test, expect } = require('@playwright/test');

// The sidebar lists only pages the role may open. Webhooks was shown to Sales
// Reps, whose role has no settings access, and the page answered 403.
test('a Sales Rep is not offered Webhooks, which their role cannot open', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const roles = (await (await request.get('/api/users/roles/all', { headers })).json()).data;
  const email = `rep-${Math.random().toString(36).slice(2, 10)}@example.org`;
  const created = await request.post('/api/users', { headers, data: { email, password: 'Sales-rep-pass-1!', firstName: 'Sam', lastName: 'Rep', roleId: roles.find(r => r.name === 'Sales Rep').id } });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill('Sales-rep-pass-1!');
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
  const nav = page.getByRole('navigation').first();
  await nav.getByRole('button', { name: 'Tools', exact: true }).click();
  await nav.getByRole('button', { name: 'More', exact: true }).click();
  await expect(nav.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Webhooks', exact: true })).toHaveCount(0);
});
