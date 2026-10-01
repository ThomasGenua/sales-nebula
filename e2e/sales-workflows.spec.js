const { test, expect } = require('@playwright/test');

const unique = () => Math.random().toString(36).slice(2, 10);
async function signIn(page, reader = false) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(reader ? 'pilot-reader@example.com' : 'pilot-admin@example.com');
  await page.getByLabel(/^Password/).fill(reader ? 'Pilot-reader-123!' : 'Pilot-admin-123!');
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
}
async function auth(request) {
  const response = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  expect(response.ok()).toBeTruthy(); return { Authorization: `Bearer ${(await response.json()).token}` };
}
async function create(request, module, data, headers) {
  const response = await request.post(`/api/${module}`, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy(); return response.json();
}

test('convert a lead in the browser and open its linked deal', async ({ page, request }) => {
  const headers = await auth(request); const suffix = unique();
  const lead = await create(request, 'leads', { firstName: 'Avery', lastName: suffix, company: `Pilot ${suffix}`, email: `avery-${suffix}@example.com` }, headers);
  await signIn(page); await page.goto(`/app/leads/${lead.id}`);
  await page.getByRole('button', { name: 'Convert lead', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert lead', exact: true });
  await dialog.getByLabel('Create account from company').check(); await dialog.getByLabel('Create deal', { exact: true }).check();
  await dialog.getByLabel('Deal value').fill('2400'); await dialog.getByLabel('Deal close date').fill('2027-01-15');
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(page.getByText('Lead converted. Open the records below to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Open deal', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Pilot ${suffix} - New Deal`, exact: true })).toBeVisible();
  const saved = await (await request.get(`/api/leads/${lead.id}`, { headers })).json();
  expect(saved.convertedAt).toBeTruthy(); expect(saved.contactId).toBeTruthy();
});

test('send email from a contact and verify actual SMTP delivery', async ({ page, request }) => {
  const headers = await auth(request); const suffix = unique(); const email = `mail-${suffix}@example.com`;
  const contact = await create(request, 'contacts', { firstName: 'Morgan', lastName: suffix, email }, headers);
  await signIn(page); await page.goto(`/app/contacts/${contact.id}`);
  await page.getByRole('button', { name: 'Compose email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compose email' });
  await expect(dialog.getByLabel('Recipient')).toHaveValue(email);
  await dialog.getByLabel('Subject').fill(`Proposal ${suffix}`); await dialog.getByLabel('Message').fill('Here is the proposal we discussed.');
  const delivery = page.waitForResponse(response => response.url().endsWith('/api/emails/send') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Send email', exact: true }).click();
  expect((await delivery).ok()).toBeTruthy();
  await expect(page.getByText('Email sent.', { exact: true })).toBeVisible();
  const mail = await (await request.get('/__test/mail')).json();
  expect(mail.some(m => m.to.includes(email) && m.content.includes(`Proposal ${suffix}`))).toBeTruthy();
  const emails = await (await request.get('/api/emails', { headers })).json();
  const saved = emails.data.find(m => m.subject === `Proposal ${suffix}`);
  expect(saved.status).toBe('sent'); expect(saved.contactId).toBe(contact.id);
});

test('send an existing email draft', async ({ page, request }) => {
  const headers = await auth(request); const suffix = unique();
  const email = await create(request, 'emails', { to: `draft-${suffix}@example.com`, subject: `Draft ${suffix}`, body: 'Draft body' }, headers);
  await signIn(page); await page.goto(`/app/emails/${email.id}`);
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('Email sent.', { exact: true })).toBeVisible();
  const saved = await (await request.get(`/api/emails/${email.id}`, { headers })).json(); expect(saved.status).toBe('sent');
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toHaveCount(0);
});

test('a rejected delivery stays failed and is reported to the user', async ({ page, request }) => {
  const headers = await auth(request); const suffix = unique();
  const email = await create(request, 'emails', { to: `failure-${suffix}@example.com`, subject: `[reject-delivery] ${suffix}`, body: 'No delivery expected' }, headers);
  await signIn(page); await page.goto(`/app/emails/${email.id}`);
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText(/Email failed:/)).toBeVisible();
  const saved = await (await request.get(`/api/emails/${email.id}`, { headers })).json();
  expect(saved.status).toBe('failed'); expect(saved.sentAt).toBeNull();
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeVisible();
});

test('create a quote with lines, preview it, record acceptance and create an invoice', async ({ page, request }) => {
  const headers = await auth(request); const suffix = unique();
  const product = await create(request, 'products', { name: `Service ${suffix}`, sku: `SKU-${suffix}`, price: 100, active: true }, headers);
  await signIn(page); await page.goto('/app/quotes');
  await page.getByRole('button', { name: /New Quote/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New Quote' });
  await dialog.getByLabel('Quote Name').fill(`Pilot quote ${suffix}`);
  await dialog.getByLabel('Discount', { exact: true }).fill('5'); await dialog.getByLabel('Tax amount').fill('10');
  await dialog.getByRole('button', { name: 'Add product line' }).click();
  await dialog.getByLabel('Search product for line 1').fill(suffix);
  const productPicker = dialog.getByRole('combobox', { name: 'Product for line 1', exact: true });
  await expect(productPicker.locator(`option[value="${product.id}"]`)).toBeAttached();
  await productPicker.selectOption(product.id);
  await dialog.getByLabel('Quantity for line 1').fill('2'); await dialog.getByLabel('Discount amount for line 1').fill('20');
  await expect(dialog.getByLabel('Quote totals')).toContainText('185');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.locator('#main-content').getByText(`Pilot quote ${suffix}`, { exact: true }).click();
  await expect(page.getByLabel('Product lines')).toContainText(`Service ${suffix}`);
  await page.getByRole('button', { name: 'Preview quote' }).click();
  await expect(page.frameLocator('iframe[title="Quote document"]').getByText(`Service ${suffix}`)).toBeVisible();
  await page.getByRole('dialog', { name: 'Quote preview' }).getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Record acceptance' }).click();
  await page.getByRole('button', { name: 'Confirm acceptance' }).click();
  await expect(page.getByRole('button', { name: 'Record acceptance' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create invoice', exact: true }).click();
  await expect(page.getByText(/Invoice created with 1 product lines/)).toBeVisible();
  await page.getByRole('button', { name: /Open invoice INV-/ }).click();
  await expect(page.getByLabel('Product lines')).toContainText(`Service ${suffix}`);
  const invoices = await (await request.get('/api/invoices', { headers })).json();
  const invoice = invoices.data.find(i => i.items.some(item => item.productId === product.id));
  expect(invoice.total).toBe(185); expect(invoice.items[0].total).toBe(180);
});

test('read-only users cannot use sales mutation actions', async ({ page, request }) => {
  const headers = await auth(request); const suffix = unique();
  const lead = await create(request, 'leads', { firstName: 'Read', lastName: suffix, company: 'Read only' }, headers);
  const contact = await create(request, 'contacts', { firstName: 'Read', lastName: suffix, email: 'read@example.com' }, headers);
  const deal = await create(request, 'deals', { name: `Read deal ${suffix}`, value: 0 }, headers);
  const quote = await create(request, 'quotes', { name: `Read ${suffix}` }, headers);
  await signIn(page, true); await page.goto(`/app/leads/${lead.id}`);
  await expect(page.getByText('Lead and contact edit permission is required to convert a lead.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convert lead', exact: true })).toHaveCount(0);
  await page.goto(`/app/contacts/${contact.id}`); await expect(page.getByRole('heading', { name: suffix, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compose email' })).toHaveCount(0);
  await page.goto(`/app/deals/${deal.id}`); await expect(page.getByRole('heading', { name: `Read deal ${suffix}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Submit.*approval/i })).toHaveCount(0);
  await page.goto(`/app/quotes/${quote.id}`); await expect(page.getByRole('button', { name: 'Preview quote' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create invoice', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record acceptance' })).toHaveCount(0);
});

test('request access, verify, approve, accept invite and sign in', async ({ page, request, browser }) => {
  const suffix = unique(); const email = `new-user-${suffix}@example.org`;
  await page.goto('/'); await page.getByLabel('First name', { exact: true }).fill('New'); await page.getByLabel('Last name', { exact: true }).fill(suffix);
  await page.getByLabel('Work email').fill(email); await page.getByLabel('Company', { exact: true }).fill(`New company ${suffix}`);
  const submission = page.waitForResponse(r => r.url().endsWith('/api/signup') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Submit request' }).click(); const result = await (await submission).json();
  await page.goto(result.devVerifyUrl); await expect(page.getByText(/Email confirmed/i).first()).toBeVisible();
  await signIn(page); await page.goto('/app/accessRequests');
  const card = page.getByText(email, { exact: true }).locator('..').locator('..').locator('..');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  const approved = page.waitForResponse(r => r.url().includes('/approve') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Approve and send invite' }).click(); const invite = await (await approved).json(); expect(invite.approved).toBe(true);
  const newcomer = await browser.newContext(); const invitePage = await newcomer.newPage();
  await invitePage.goto(invite.devInviteUrl); await invitePage.getByLabel('Password', { exact: true }).fill('New-user-password-123!');
  await invitePage.getByLabel('Confirm password', { exact: true }).fill('New-user-password-123!');
  await invitePage.getByRole('button', { name: /Create account|Join|Set password|Accept invite/i }).click();
  await expect(invitePage.locator('#main-content')).toBeVisible(); await newcomer.close();
});

test('quote editor works at phone width in the light theme', async ({ page, request }) => {
  await signIn(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { localStorage.setItem('sn_theme', 'light'); });
  await page.goto('/app/quotes'); await page.getByRole('button', { name: /New Quote/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New Quote' }); await dialog.getByRole('button', { name: 'Add product line' }).click();
  await expect(dialog.getByLabel('Quantity for line 1')).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await dialog.getByLabel('Quote Name').press('Escape'); await expect(dialog).toHaveCount(0);
});
