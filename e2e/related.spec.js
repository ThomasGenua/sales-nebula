const { test, expect } = require('@playwright/test');

const unique = () => Math.random().toString(36).slice(2, 10);
async function signIn(page, email = 'pilot-admin@example.com', password = 'Pilot-admin-123!') {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
}
async function auth(request) {
  const response = await request.post('/api/auth/login', { data: { email: 'pilot-admin@example.com', password: 'Pilot-admin-123!' } });
  expect(response.ok()).toBeTruthy(); return { Authorization: `Bearer ${(await response.json()).token}` };
}
async function create(request, path, data, headers) {
  const response = await request.post(`/api/${path}`, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy(); return response.json();
}

/** An account with two contacts, a deal and a quote, and another account's contact beside it. */
async function accountWithRecords(request, headers) {
  const suffix = unique();
  const account = await create(request, 'accounts', { name: `Related ${suffix}` }, headers);
  const other = await create(request, 'accounts', { name: `Elsewhere ${suffix}` }, headers);
  await create(request, 'contacts', { firstName: 'Ada', lastName: `Lovelace-${suffix}`, title: 'CTO', accountId: account.id }, headers);
  await create(request, 'contacts', { firstName: 'Bo', lastName: `Chen-${suffix}`, accountId: account.id }, headers);
  await create(request, 'contacts', { firstName: 'Cy', lastName: `Other-${suffix}`, accountId: other.id }, headers);
  await create(request, 'deals', { name: `Related deal ${suffix}`, value: 12000, accountId: account.id }, headers);
  await create(request, 'quotes', { name: `Related quote ${suffix}`, accountId: account.id }, headers);
  return { account, suffix };
}

test("an account's related records are listed on its page, and open from there", async ({ page, request }) => {
  const headers = await auth(request);
  const { account, suffix } = await accountWithRecords(request, headers);
  await signIn(page); await page.goto(`/app/accounts/${account.id}`);
  await page.getByRole('button', { name: 'Related', exact: true }).click();

  const contacts = page.getByRole('region', { name: 'Contacts', exact: true });
  await expect(contacts.getByRole('button', { name: new RegExp(`^Ada Lovelace-${suffix}`) })).toBeVisible();
  await expect(contacts.getByRole('button', { name: new RegExp(`^Bo Chen-${suffix}`) })).toBeVisible();
  await expect(contacts.getByText(`Other-${suffix}`)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Deals', exact: true }).getByText(`Related deal ${suffix}`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Quotes', exact: true }).getByText(`Related quote ${suffix}`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Invoices', exact: true }).getByText('No invoices yet')).toBeVisible();

  await contacts.getByRole('button', { name: new RegExp(`^Ada Lovelace-${suffix}`) }).click();
  await expect(page.getByRole('heading', { name: `Lovelace-${suffix}`, exact: true })).toBeVisible();
  expect(page.url()).toContain('/app/contacts/');
});

test('someone sees only the related lists of modules they may read', async ({ page, request }) => {
  const headers = await auth(request);
  const { account, suffix } = await accountWithRecords(request, headers);
  const role = await create(request, 'users/roles', {
    name: `Accounts only ${suffix}`, permissions: [{ module: 'accounts', level: 'read' }, { module: 'contacts', level: 'read' }],
  }, headers);
  const email = `narrow-${suffix}@example.org`;
  await create(request, 'users', { email, password: 'Narrow-password-1!', firstName: 'Narrow', lastName: suffix, roleId: role.id }, headers);

  await signIn(page, email, 'Narrow-password-1!'); await page.goto(`/app/accounts/${account.id}`);
  await page.getByRole('button', { name: 'Related', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Contacts', exact: true }).getByText(`Lovelace-${suffix}`)).toBeVisible();
  await expect(page.getByRole('region', { name: /^(Deals|Quotes|Cases|Invoices)$/ })).toHaveCount(0);
});

test('related lists fit a phone', async ({ page, request }) => {
  const headers = await auth(request);
  const { account } = await accountWithRecords(request, headers);
  await signIn(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/accounts/${account.id}`);
  await page.getByRole('button', { name: 'Related', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Contacts', exact: true })).toBeVisible();
  expect(await page.locator('#main-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
