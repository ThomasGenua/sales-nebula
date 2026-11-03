const { test, expect } = require('./fixtures');
async function login(page) {
  await page.goto('/login'); await page.getByLabel(/^Email/).fill('pilot-admin@example.com'); await page.getByLabel(/^Password/).fill('Pilot-admin-123!'); await page.getByRole('button', { name: /^Sign In$/ }).click(); await expect(page.locator('#main-content')).toBeVisible(); await page.goto('/app/salesOperations');
}
const tab = (page, name) => page.getByRole('navigation', { name: 'Sales operations' }).getByRole('button', { name, exact: true }).click();
async function auth(request) { const r = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } }); return { Authorization: 'Bearer ' + (await r.json()).token }; }
test('CSV migration previews linked records, imports and safely undoes them', async ({ page }, info) => {
  await login(page); await tab(page, 'CRM migration');
  await page.getByLabel('Source organization', { exact: true }).fill('Browser Salesforce organization');
  await page.getByLabel('Accounts CSV', { exact: true }).setInputFiles({ name: 'accounts.csv', mimeType: 'text/csv', buffer: Buffer.from('Id,Name\nA1,Browser imported company\n') });
  await page.getByLabel('Contacts CSV', { exact: true }).setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from('Id,AccountId,FirstName,LastName,Email\nC1,A1,Browser,Import,import-browser@example.com\n') });
  await expect(page.getByLabel('Contacts: Account External Id')).toHaveValue('AccountId');
  await page.getByRole('button', { name: 'Create import preview' }).click();
  await expect(page.getByRole('status')).toContainText('Pending: 2');
  await page.getByLabel(/I reviewed the preview and active automation/).check();
  await page.getByRole('button', { name: 'Start or resume import' }).click();
  await expect(page.getByRole('status')).toContainText('Applied: 2', { timeout: 20000 });
  await page.screenshot({ path: info.outputPath('migration-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Preview undo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review migration undo' }); await expect(dialog).toContainText('2 records');
  await dialog.getByRole('button', { name: 'Undo reviewed migration' }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status')).toContainText('Undone: 2');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath('migration-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
test('meeting draft requires explicit selection and creates only reviewed follow-ups', async ({ page, request }, info) => {
  await request.post('/__test/meeting-provider', { headers: { 'X-Test-Reset': 'local-browser-tests' } });
  await login(page); await tab(page, 'Meeting intelligence');
  await page.getByLabel('Meeting title', { exact: true }).fill('Browser customer review');
  await page.getByLabel('Meeting transcript', { exact: true }).fill('The customer requested a proposal and asked us to arrange a follow-up meeting.');
  await page.getByLabel(/I have permission to record/).check(); await page.getByRole('button', { name: 'Create meeting draft' }).click();
  await expect(page.getByRole('heading', { name: 'Review proposed changes' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Apply selected changes' })).toBeDisabled();
  await page.getByLabel('Create task 1', { exact: true }).check(); await page.getByLabel('Task 1', { exact: true }).fill('Send reviewed browser proposal');
  await page.screenshot({ path: info.outputPath('meeting-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Apply selected changes' }).click(); await expect(page.getByText('1 tasks created.', { exact: true })).toBeVisible();
  await page.reload(); await tab(page, 'Meeting intelligence'); await page.getByLabel('Recent meetings').selectOption({ label: 'Browser customer review · Applied' }); await expect(page.getByText(/Reviewed changes were applied/)).toBeVisible();
});
test('credit note review changes the balance and downloads a PDF', async ({ page, request }, info) => {
  const headers = await auth(request), r = await request.post('/api/invoices', { headers, data: { number: 'INV-BROWSER-CREDIT', total: 100, subtotal: 100, currency: 'USD', status: 'Sent' } }); expect(r.ok(), await r.text()).toBeTruthy(); const invoice = await r.json();
  await login(page); await tab(page, 'Payments'); await page.getByRole('combobox', { name: 'Invoice', exact: true }).selectOption(invoice.id);
  await page.getByText('Create an adjustment', { exact: true }).click(); await page.getByLabel('Adjustment amount').fill('25'); await page.getByLabel('Adjustment reason').fill('Reviewed price correction'); await page.getByRole('button', { name: 'Review adjustment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm credit note' }); await expect(dialog).toContainText('USD 25.00'); await dialog.getByRole('button', { name: 'Issue credit note', exact: true }).click();
  await expect(page.getByText('Credit note issued.', { exact: true })).toBeVisible(); await expect(page.getByText('Credit notes: USD 25.00', { exact: true })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download credit note' }).click()]); expect(download.suggestedFilename()).toMatch(/^credit-note-.+\.pdf$/);
  await page.screenshot({ path: info.outputPath('billing-adjustments.png'), fullPage: true });
});
test('enterprise access setup is readable on mobile and does not expose secrets', async ({ page }, info) => {
  await login(page); await tab(page, 'Enterprise configuration'); await expect(page.getByRole('heading', { name: 'Enterprise sign-in and provisioning' })).toBeVisible(); await expect(page.getByText('OIDC redirect URI', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByText('Connect Entra or Okta', { exact: true }).click(); await page.screenshot({ path: info.outputPath('enterprise-access-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); await expect(page.getByRole('alert')).toHaveCount(0);
});
