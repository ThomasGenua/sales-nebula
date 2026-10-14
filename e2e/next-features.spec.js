const { test, expect } = require('@playwright/test');
const unique = () => Math.random().toString(36).slice(2, 9);
async function login(page, request) {
  const response = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  expect(response.ok()).toBeTruthy(); const headers = { Authorization: 'Bearer ' + (await response.json()).token };
  await page.goto('/login'); await page.getByLabel(/^Email/).fill('pilot-admin@example.com'); await page.getByLabel(/^Password/).fill('Pilot-admin-123!');
  await page.getByRole('button', { name: /^Sign In$/i }).click(); await expect(page.locator('#main-content')).toBeVisible(); return headers;
}
async function create(request, route, data, headers) { const r = await request.post('/api/' + route, { data, headers }); expect(r.ok(), await r.text()).toBeTruthy(); return r.json(); }
test('custom field form stores a value, exposes it in lists, and survives a refresh', async ({ page, request }, info) => {
  const headers = await login(page, request), suffix = unique();
  const field = await create(request, 'studio/fields', { module: 'contacts', label: 'Score ' + suffix, fieldType: 'number' }, headers);
  const contact = await create(request, 'contacts', { firstName: 'Custom', lastName: suffix, email: suffix + '@example.test' }, headers);
  await page.goto('/app/contacts/' + contact.id); const section = page.getByRole('region', { name: 'Custom fields', exact: true });
  await section.getByLabel(field.label).fill('42'); await section.getByRole('button', { name: 'Save custom fields' }).click(); await expect(section.getByText('Custom fields saved.')).toBeVisible();
  await page.reload(); await expect(section.getByLabel(field.label)).toHaveValue('42');
  await page.screenshot({ path: info.outputPath('custom-fields.png'), fullPage: true });
  const list = await (await request.get('/api/contacts?custom.' + field.name + '=42', { headers })).json(); expect(list.data.map(r => r.id)).toContain(contact.id);
});
test('import wizard maps headings, lets a user correct a row, and imports after preview', async ({ page, request }, info) => {
  await login(page, request); const suffix = unique();
  await page.goto('/app/import');
  await page.locator('input[type=file]').setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from('Given,Surname,Email\nAda,One,' + suffix + '-one@example.test\nBen,Two,broken-address\n') });
  await page.getByRole('combobox', { name: 'Given', exact: true }).selectOption('firstName'); await page.getByRole('combobox', { name: 'Surname', exact: true }).selectOption('lastName');
  await page.getByRole('button', { name: 'Check file' }).click(); await expect(page.getByText(/Row 2: Invalid email format/)).toBeVisible();
  await page.getByLabel('Row 2 Email', { exact: true }).fill(suffix + '-two@example.test'); await page.getByRole('button', { name: 'Check file' }).click(); await expect(page.getByText('No problems found', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start Import' }).click(); await expect(page.getByText('2 created, 0 updated, 0 skipped')).toBeVisible(); await expect(page.getByRole('button', { name: 'Start Import' })).toBeDisabled();
  // The server validates batches independently; the wizard also detects duplicates spanning batches.
  await page.route('**/api/import/validate', route => route.fulfill({ json: { valid: true, errors: [], errorCount: 0, warningCount: 0, duplicates: [], duplicateCount: 0 } }));
  const rows = Array.from({ length: 501 }, (_, i) => 'Person,Example,row-' + (i === 500 ? 0 : i) + '@example.test');
  await page.locator('input[type=file]').setInputFiles({ name: 'duplicates.csv', mimeType: 'text/csv', buffer: Buffer.from('firstName,lastName,email\n' + rows.join('\n')) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('1 duplicates found to skip.')).toBeVisible();
  await expect(page.getByText('Row 501: row-0@example.test matches file row 1.')).toBeVisible();
});
test('visual workflow saves conditions and actions and previews without running them', async ({ page, request }, info) => {
  const headers = await login(page, request), suffix = unique();
  const lead = await create(request, 'leads', { firstName: 'Workflow', lastName: suffix, company: 'Preview Co' }, headers);
  await page.goto('/app/workflows'); await page.getByRole('button', { name: 'New workflow' }).click(); await page.getByLabel('Workflow name').fill('Follow up ' + suffix);
  await page.getByRole('button', { name: 'Add condition' }).click(); await page.getByLabel('Condition 1 field').selectOption('company'); await page.getByLabel('Value', { exact: true }).fill('Preview Co');
  await page.getByRole('button', { name: 'Add action' }).click(); await page.getByLabel('Follow-up subject').fill('Call ' + suffix);
  await page.getByLabel('Search preview record').fill(suffix); const picker = page.getByRole('combobox', { name: 'Preview record', exact: true }); await expect(picker.locator('option[value="' + lead.id + '"]')).toBeAttached(); await picker.selectOption(lead.id);
  await page.getByRole('button', { name: 'Preview workflow', exact: true }).click(); await expect(page.getByText(/Conditions match.*No changes were made/)).toBeVisible();
  await page.getByRole('button', { name: 'Save workflow', exact: true }).click(); await expect(page.getByText('Workflow saved.', { exact: true })).toBeVisible(); await page.screenshot({ path: info.outputPath('workflow-builder.png'), fullPage: true });
  const tasks = await (await request.get('/api/activities?leadId=' + lead.id, { headers })).json(); expect(tasks.data).toHaveLength(0);
});
test('customer quote downloads a PDF and accepts through the public page', async ({ page, request, browser }, info) => {
  const headers = await login(page, request), suffix = unique();
  const product = await create(request, 'products', { name: 'Consulting ' + suffix, sku: 'SKU-' + suffix, price: 150 }, headers);
  const quote = await create(request, 'quotes', { items: [{ productId: product.id, quantity: 2, unitPrice: 150, discount: 0 }], terms: 'Due in 30 days.' }, headers);
  await page.goto('/app/quotes/' + quote.id); const sharing = page.getByRole('region', { name: 'Customer quote sharing' });
  const download = page.waitForEvent('download'); await sharing.getByRole('button', { name: 'Download quote PDF' }).click(); const file = await download; expect(file.suggestedFilename()).toMatch(/\.pdf$/); await file.saveAs(info.outputPath('customer-quote.pdf'));
  await sharing.getByRole('button', { name: 'Create customer link' }).click(); const input = sharing.getByLabel('Customer link — copy and share'); await expect(input).toHaveValue(/\/api\/public\/quotes\//); const url = await input.inputValue();
  const context = await browser.newContext(); const customer = await context.newPage(); await customer.goto(url);
  await expect(customer.getByRole('heading', { name: 'Quote ' + quote.number, exact: true })).toBeVisible(); await customer.getByLabel('Your full name').fill('Ada Customer'); await customer.getByLabel('Email address').fill('ada@example.test'); await customer.getByLabel('I accept this quote and its terms.').check();
  await customer.screenshot({ path: info.outputPath('customer-quote.png'), fullPage: true });
  await customer.getByRole('button', { name: 'Accept quote', exact: true }).click(); await expect(customer.getByRole('heading', { name: 'Accepted', exact: true })).toBeVisible(); await context.close();
  await page.reload(); await expect(sharing.getByText(/Accepted by Ada Customer/)).toBeVisible();
});
test('calendar creates a linked local meeting and explains Outlook configuration', async ({ page, request }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const headers = await login(page, request), suffix = unique();
  await create(request, 'sales-mail/accounts', { name: 'Test calendar ' + suffix }, headers);
  await page.goto('/app/calendar'); await page.getByText('Outlook meetings and calendar sync', { exact: true }).click();
  const section = page.getByRole('region', { name: 'Outlook calendar', exact: true });
  await section.getByRole('button', { name: 'New meeting', exact: true }).click(); await section.getByLabel('Meeting title').fill('Planning ' + suffix); await section.getByLabel('Attendee emails (comma separated)').fill('customer@example.test');
  await section.getByRole('button', { name: 'Save meeting locally' }).click(); await expect(section.getByText('Meeting saved locally. Publish to send invitations or updates through Outlook.')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Publish and send Outlook invitations' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath('outlook-calendar-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(errors).toEqual([]);
});
