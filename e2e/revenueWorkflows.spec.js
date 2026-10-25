const {
  test,
  expect
} = require('@playwright/test');
async function login(page) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('pilot-admin@example.com');
  await page.getByLabel(/^Password/).fill('Pilot-admin-123!');
  await page.getByRole('button', {
    name: /^Sign In$/i
  }).click();
  await expect(page.locator('#main-content')).toBeVisible();
  await page.goto('/app/salesOperations');
}
const tab = (page, name) => page.getByRole('navigation', {
  name: 'Sales operations'
}).getByRole('button', {
  name,
  exact: true
}).click();
test('revenue workspace creates computed fields and a success template', async ({
  page
}, info) => {
  await login(page);
  await tab(page, 'Computed fields');
  await expect(page.getByRole('heading', {
    name: 'Formula fields and rollups'
  })).toBeVisible();
  await page.getByText('Add a computed field', {
    exact: true
  }).click();
  await page.getByLabel('Field name', {
    exact: true
  }).fill('Browser weighted revenue');
  await page.getByLabel('Formula', {
    exact: true
  }).fill('value * probability / 100');
  await page.getByRole('button', {
    name: 'Create computed field',
    exact: true
  }).click();
  await expect(page.getByText('Browser weighted revenue', {
    exact: true
  })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('computed-fields.png'),
    fullPage: true
  });
  await tab(page, 'Account success');
  await page.getByText('Create a playbook template', {
    exact: true
  }).click();
  await page.getByLabel('Playbook name', {
    exact: true
  }).fill('Browser onboarding');
  await page.getByRole('button', {
    name: 'Save playbook template',
    exact: true
  }).click();
  await expect(page.getByText('Playbook template created.', {
    exact: true
  })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('success-playbook.png'),
    fullPage: true
  });
  for (const [name, heading] of [['Payments', 'Invoice payments'], ['Deal rooms', 'Customer deal rooms'], ['Campaign delivery', 'Campaign delivery']]) {
    await tab(page, name);
    await expect(page.getByRole('heading', {
      name: heading,
      exact: true
    })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});
test('payments screen records a partial receipt and downloads a real PDF', async ({
  page,
  request
}, info) => {
  const auth = await request.post('/api/auth/login', {
    data: {
      email: 'pilot-admin@example.com',
      password: 'Pilot-admin-123!'
    }
  });
  const headers = {
    Authorization: 'Bearer ' + (await auth.json()).token
  };
  const created = await request.post('/api/invoices', {
    headers,
    data: {
      total: 100,
      subtotal: 100,
      currency: 'USD'
    }
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const invoice = await created.json();
  await login(page);
  await tab(page, 'Payments');
  await page.getByRole('combobox', {
    name: 'Invoice',
    exact: true
  }).selectOption(invoice.id);
  await expect(page.getByRole('button', {
    name: 'Record received payment',
    exact: true
  })).toBeVisible();
  await page.getByLabel('Payment amount', {
    exact: true
  }).fill('30');
  await page.getByLabel('Bank or payment reference', {
    exact: true
  }).fill('browser-receipt');
  await page.getByRole('button', {
    name: 'Record received payment',
    exact: true
  }).click();
  await expect(page.getByText('Payment recorded.', {
    exact: true
  })).toBeVisible();
  await expect(page.getByText('USD 70.00', {
    exact: true
  })).toBeVisible();
  const pdf = await request.get('/api/invoices/' + invoice.id + '/pdf', {
    headers
  });
  expect(pdf.ok()).toBeTruthy();
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
  await page.screenshot({
    path: info.outputPath('partial-payment.png'),
    fullPage: true
  });
});
