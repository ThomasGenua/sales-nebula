const { test, expect } = require('@playwright/test');

const unique = () => Math.random().toString(36).slice(2, 8);
async function adminHeaders(request) {
  const login = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  return { Authorization: `Bearer ${(await login.json()).token}` };
}
async function signIn(page, email = 'pilot-admin@example.com', password = 'Pilot-admin-123!') {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
}
/** Opens a page from the sidebar, through its section and that section's More menu. */
async function openFromNav(page, path, heading) {
  const nav = page.getByRole('navigation').first();
  for (const name of path) await nav.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

// The bin could not be searched: a name lived only in each entry's snapshot.
test('the recycle bin finds a deleted record by any part of its name, in any case', async ({ page, request }) => {
  const headers = await adminHeaders(request);
  const lastName = `Findable${unique()}`;
  for (const firstName of ['Ada', 'Grace']) {
    const created = await request.post('/api/contacts', { headers, data: { firstName, lastName: firstName === 'Ada' ? lastName : `Other${unique()}` } });
    expect(created.ok(), await created.text()).toBeTruthy();
    expect((await request.delete(`/api/contacts/${(await created.json()).id}`, { headers })).ok()).toBeTruthy();
  }

  await signIn(page);
  await openFromNav(page, ['Tools', 'More', 'Recycle Bin'], 'Recycle Bin');
  await page.getByLabel('Search the bin').fill(lastName.toLowerCase().slice(2));
  const entry = page.getByText(`Ada ${lastName}`, { exact: true });
  await expect(entry).toBeVisible();
  await expect(page.getByText(/^Grace /)).toHaveCount(0);
  await expect(page.getByText('Contact', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(entry).toHaveCount(0);
});

// Scoring rules had no screen; they were managed through the API alone.
test('lead scoring rules are written, switched off and removed on their own screen', async ({ page, request }) => {
  const headers = await adminHeaders(request);
  const name = `Nebula company ${unique()}`;
  await signIn(page);
  await openFromNav(page, ['Automation & AI', 'More', 'Lead Scoring'], 'Lead Scoring');

  await page.getByRole('button', { name: 'Add rule' }).click();
  const form = page.getByRole('region', { name: 'New rule' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await form.getByRole('combobox', { name: 'Field', exact: true }).selectOption('company');
  await form.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('contains');
  await form.getByRole('textbox', { name: 'Value', exact: true }).fill('nebula');
  await form.getByRole('spinbutton', { name: 'Points', exact: true }).fill('30');
  await form.getByRole('button', { name: 'Save rule' }).click();
  const rule = page.getByRole('listitem').filter({ hasText: name });
  await expect(rule).toContainText('If Company contains "nebula": +30 points');

  // A lead saved now is scored by it.
  const lead = await request.post('/api/leads', { headers, data: { firstName: 'Ada', lastName: 'Lovelace', company: 'Nebula Corp' } });
  const without = await request.post('/api/leads', { headers, data: { firstName: 'Bob', lastName: 'Plain', company: 'Plain Ltd' } });
  expect((await lead.json()).score - (await without.json()).score).toBe(30);

  await page.getByRole('button', { name: 'Rescore open leads' }).click();
  await expect(page.getByRole('status')).toContainText(/Rescored \d+ open leads?/);

  await rule.getByRole('button', { name: 'Switch off' }).click();
  await expect(rule).toContainText('Off');
  page.once('dialog', dialog => dialog.accept());
  await rule.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
});

test('someone who may only read the rules sees them without the controls', async ({ page, request }) => {
  const headers = await adminHeaders(request);
  const name = `Read-only view ${unique()}`;
  expect((await request.post('/api/admin/scoring-rules', { headers, data: { name, field: 'source', operator: 'equals', value: 'Referral', points: 15 } })).ok()).toBeTruthy();
  await signIn(page, 'pilot-reader@example.com', 'Pilot-reader-123!');
  await openFromNav(page, ['Automation & AI', 'More', 'Lead Scoring'], 'Lead Scoring');
  await expect(page.getByRole('listitem').filter({ hasText: name })).toContainText('If Source equals "Referral": +15 points');
  await expect(page.getByRole('button', { name: 'Add rule' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

// Monitoring had no screen; its figures and lists were API only.
test('monitoring shows API events and sign-ins', async ({ page }) => {
  await signIn(page);
  const nav = page.getByRole('navigation').first();
  await nav.getByRole('button', { name: 'Monitoring', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Monitoring', level: 1 })).toBeVisible();
  await expect(page.getByText('API calls, last hour')).toBeVisible();

  // Events are written a moment after each request.
  const events = page.getByRole('region', { name: 'API events' });
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    return events.getByRole('row').count();
  }, { timeout: 20000 }).toBeGreaterThan(1);
  await expect(events).toContainText('GET /api/');
  await expect(events).not.toContainText('?');

  await page.getByRole('tab', { name: 'Sign-ins' }).click();
  await expect(page.getByRole('region', { name: 'Sign-ins' })).toContainText('Succeeded');
});

test('a Sales Rep, who may not see everyone\'s activity, is not offered Monitoring', async ({ page, request }) => {
  const headers = await adminHeaders(request);
  const roles = (await (await request.get('/api/users/roles/all', { headers })).json()).data;
  const email = `rep-${unique()}@example.org`;
  const created = await request.post('/api/users', { headers, data: { email, password: 'Sales-rep-pass-1!', firstName: 'Sam', lastName: 'Rep', roleId: roles.find(r => r.name === 'Sales Rep').id } });
  expect(created.ok(), await created.text()).toBeTruthy();
  await signIn(page, email, 'Sales-rep-pass-1!');
  await expect(page.getByRole('navigation').first().getByRole('button', { name: 'Monitoring', exact: true })).toHaveCount(0);
});
