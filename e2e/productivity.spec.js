const { test, expect } = require('@playwright/test');
const unique = () => Math.random().toString(36).slice(2, 9);
async function login(page, request, reader = false) {
  const email = reader ? 'pilot-reader@example.com' : 'pilot-admin@example.com';
  const password = reader ? 'Pilot-reader-123!' : 'Pilot-admin-123!';
  const response = await request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok()).toBeTruthy(); const headers = { Authorization: `Bearer ${(await response.json()).token}` };
  await page.goto('/login'); await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(password); await page.getByRole('button', { name: /^Sign In$/i }).click(); await expect(page.locator('#main-content')).toBeVisible();
  return headers;
}
async function create(request, module, data, headers) { const r = await request.post(`/api/${module}`, { headers, data }); expect(r.ok(), await r.text()).toBeTruthy(); return r.json(); }

test('My Day completes an overdue task and schedules its linked follow-up', async ({ page, request }) => {
  const headers = await login(page, request), suffix = unique();
  const deal = await create(request, 'deals', { name: `Follow-up deal ${suffix}`, value: 100 }, headers);
  const task = await create(request, 'activities', { subject: `Call customer ${suffix}`, type: 'Task', dueDate: '2020-01-01', dealId: deal.id }, headers);
  await page.goto('/app/myDay');
  const row = page.getByRole('article').filter({ hasText: task.subject }); await row.getByRole('button', { name: 'Complete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Complete activity' }); await dialog.getByLabel('Outcome').fill('Agreed next meeting'); await dialog.getByLabel('Schedule a follow-up').check(); await dialog.getByLabel('Due date').fill('2027-01-15'); await dialog.getByRole('button', { name: 'Complete activity' }).click();
  await expect(dialog).toHaveCount(0); await expect(row).toHaveCount(0);
  const list = await (await request.get(`/api/activities?dealId=${deal.id}`, { headers })).json(); expect(list.data.find(t => t.subject === `Follow-up: ${task.subject}`).status).toBe('Scheduled');
});

test('pipeline moves a deal, saves filters, and restores them after refresh', async ({ page, request }) => {
  const headers = await login(page, request), suffix = unique();
  const deal = await create(request, 'deals', { name: `Board ${suffix}`, value: 1250 }, headers);
  await page.goto('/app/pipeline'); await page.getByLabel('Search deals').fill(suffix);
  await expect(page.getByRole('button', { name: deal.name, exact: true })).toBeVisible();
  await page.getByLabel(`Stage for ${deal.name}`).selectOption('Proposal');
  await expect(page.getByRole('region', { name: 'Proposal', exact: true }).getByRole('button', { name: deal.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save current view' }).click();
  const modal = page.getByRole('dialog', { name: 'Save current view' }); await modal.getByLabel('View name').fill(`Board view ${suffix}`); await modal.getByRole('button', { name: 'Save view', exact: true }).click(); await expect(modal).toHaveCount(0);
  await page.reload(); await page.getByRole('combobox', { name: 'Saved view', exact: true }).selectOption({ label: `Board view ${suffix}` }); await expect(page.getByLabel('Search deals')).toHaveValue(suffix);
});

test('create a task from a deal related list with its relationship prefilled', async ({ page, request }) => {
  const headers = await login(page, request), suffix = unique(); const deal = await create(request, 'deals', { name: `Related task ${suffix}`, value: 100 }, headers);
  await page.goto(`/app/deals/${deal.id}`); await page.getByRole('button', { name: 'Related', exact: true }).click(); await page.getByRole('region', { name: 'Activities', exact: true }).getByRole('button', { name: 'New task' }).click();
  const modal = page.getByRole('dialog'); await modal.getByLabel('Subject').fill(`Linked task ${suffix}`); await modal.getByRole('button', { name: 'Create', exact: true }).click(); await expect(modal).toHaveCount(0);
  const rows = await (await request.get(`/api/activities?dealId=${deal.id}`, { headers })).json(); expect(rows.data.some(t => t.subject === `Linked task ${suffix}`)).toBe(true);
});

test('report builder saves a shared definition and drills into actual records', async ({ page, request }) => {
  const headers = await login(page, request), suffix = unique(); await create(request, 'deals', { name: `Report ${suffix}`, value: 123 }, headers);
  await page.goto('/app/reports'); await page.getByRole('button', { name: 'Pipeline report', exact: true }).click(); await page.getByLabel('Report name').fill(`Saved report ${suffix}`); await page.getByLabel('Share report definition with everyone').check();
  await page.getByRole('button', { name: 'Save report', exact: true }).click(); await expect(page.getByText('Report saved.', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Run report', exact: true }).click();
  const results = page.getByRole('region', { name: 'Report results' }); await expect(results).toBeVisible(); await results.getByRole('button', { name: 'View records' }).first().click(); await expect(results.getByRole('button', { name: 'Back to summary' })).toBeVisible(); await expect(results.getByRole('button', { name: 'Open record' }).first()).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: `Saved report ${suffix} · shared` }).click(); await expect(page.getByLabel('Report name')).toHaveValue(`Saved report ${suffix}`);
});

test('sequence editor saves steps, enrolls a contact, and pauses the sequence', async ({ page, request }) => {
  const headers = await login(page, request), suffix = unique(); const contact = await create(request, 'contacts', { firstName: 'Sequence', lastName: suffix, email: `sequence-${suffix}@example.test` }, headers);
  await page.goto('/app/sequences'); await page.getByRole('button', { name: 'New sequence' }).click(); await page.getByLabel('Sequence name').fill(`Sequence ${suffix}`); await page.getByRole('button', { name: 'Add email step' }).click(); await page.getByLabel('Step 1 subject').fill(`Hello ${suffix}`); await page.getByLabel('Step 1 email body').fill('Following up on our conversation.'); await page.getByRole('button', { name: 'Save sequence', exact: true }).click(); await expect(page.getByText('Sequence saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Activate sequence' }).click(); await expect(page.getByRole('button', { name: 'Pause sequence' })).toBeVisible();
  await page.getByLabel('Search person').fill(suffix); const picker = page.getByRole('combobox', { name: 'Person', exact: true }); await expect(picker.locator(`option[value="${contact.id}"]`)).toBeAttached(); await picker.selectOption(contact.id); await page.getByRole('button', { name: 'Enroll selected people' }).click(); await expect(page.getByRole('button', { name: 'Stop enrollment' })).toBeVisible(); await page.getByRole('button', { name: 'Pause sequence' }).click(); await expect(page.getByRole('button', { name: 'Activate sequence' })).toBeVisible();
});

test('mailbox setup is explicit and read-only users get no write controls', async ({ page, request }) => {
  await login(page, request, true); await page.goto('/app/mailbox'); await expect(page.getByRole('heading', { name: 'Mailbox', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add Outlook mailbox' })).toHaveCount(0);
  await page.goto('/app/pipeline'); await expect(page.getByRole('heading', { name: 'Pipeline', exact: true })).toBeVisible(); await expect(page.getByRole('combobox', { name: /^Stage for/ })).toHaveCount(0);
  await page.goto('/app/myDay'); await expect(page.getByRole('button', { name: 'New task', exact: true })).toHaveCount(0);
});

test('sales workspace screens render on desktop and mobile without script errors', async ({ page, request }, testInfo) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const headers = await login(page, request);
  const deal = await create(request, 'deals', { name: 'Northstar renewal', value: 24000, stage: 'Proposal' }, headers);
  const sequence = await create(request, 'sequences', { name: 'New prospect follow-up', steps: [{ delayDays: 0, subject: 'Thanks for your interest', body: 'Let us arrange a time to discuss your plans.' }, { delayDays: 3, subject: 'A quick follow-up', body: 'Is there anything I can clarify before our next conversation?' }] }, headers);
  await create(request, 'activities', { subject: 'Confirm renewal scope', type: 'Task', dueDate: '2020-01-01', dealId: deal.id }, headers);
  async function ready(route) {
    if (route === 'pipeline') await expect(page.getByRole('button', { name: 'Northstar renewal', exact: true })).toBeVisible();
    if (route === 'myDay') await expect(page.getByText('Confirm renewal scope', { exact: true })).toBeVisible();
    if (route === 'sequences') await expect(page.getByLabel('Step 1 subject')).toHaveValue('Thanks for your interest');
    if (route === 'mailbox') await expect(page.getByText('No messages match. Sync a connected mailbox to get started.', { exact: true })).toBeVisible();
    if (route === 'reports') {
      await page.getByRole('button', { name: 'Pipeline report', exact: true }).click();
      await page.getByRole('button', { name: 'Run report', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Report results' })).toBeVisible();
    }
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
  }
  for (const [route, heading] of [['myDay', 'My Day'], ['pipeline', 'Pipeline'], ['reports', 'Reports'], ['sequences', 'Sequences'], ['mailbox', 'Mailbox']]) {
    await page.goto(`/app/${route}${route === 'sequences' ? '/' + sequence.id : ''}`); await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await ready(route); await page.screenshot({ path: testInfo.outputPath(`${route}-desktop.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['myDay', 'pipeline', 'reports', 'sequences', 'mailbox']) {
    await page.goto(`/app/${route}${route === 'sequences' ? '/' + sequence.id : ''}`); await expect(page.locator('#main-content')).toBeVisible();
    await ready(route);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${route}-mobile.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
