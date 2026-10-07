const { test, expect } = require('@playwright/test');

// What does not work says so on its own page, and what works is wired up.
const unique = () => Math.random().toString(36).slice(2, 10);
async function signIn(page) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('pilot-admin@example.com');
  await page.getByLabel(/^Password/).fill('Pilot-admin-123!');
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
}

test('pages for features that do not run say so', async ({ page }) => {
  await signIn(page);
  for (const [path, title] of [
    ['/app/flowBuilder', 'Running flows'],
    ['/app/aiAgents', 'Running AI agents'],
    ['/app/marketplace', 'Installing apps'],
    ['/app/studio', 'Custom fields on records'],
  ]) {
    await page.goto(path);
    const notice = page.getByRole('region', { name: title, exact: true });
    await expect(notice).toBeVisible();
    await expect(notice.getByText('Unavailable', { exact: true })).toBeVisible();
  }
});

test('Copilot says when an answer comes from fixed rules, not a model', async ({ page }) => {
  // No AI key is configured for these tests, so the answer is the rule-based one.
  await signIn(page); await page.goto('/app/copilot');
  await page.getByPlaceholder('Ask about your CRM data...').fill('How many deals are open?');
  await page.keyboard.press('Enter');
  await expect(page.getByText('No AI model is set up, so this answer comes from fixed rules, not AI.')).toBeVisible();
});

test('a Chatter post can be liked and commented on', async ({ page }) => {
  await signIn(page); await page.goto('/app/chatter');
  const text = `Shipped ${unique()}`;
  await page.getByPlaceholder('Share an update...').fill(text);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  const post = page.getByRole('article').filter({ hasText: text });

  await post.getByRole('button', { name: 'Like (0)' }).click();
  await expect(post.getByRole('button', { name: 'Unlike (1)' })).toHaveAttribute('aria-pressed', 'true');

  await post.getByRole('button', { name: 'Comments (0)' }).click();
  await post.getByPlaceholder('Write a comment').fill('Nice work');
  await post.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(post.getByText('Nice work')).toBeVisible();
  await expect(post.getByRole('button', { name: 'Comments (1)' })).toBeVisible();
});

test('an email no mail server took is shown as not sent', async ({ page }) => {
  // This test server has a mail server, so nothing it sends stays queued. The
  // list is stubbed with the record the API stores when email is not set up.
  const subject = `Logged only ${unique()}`;
  const email = { id: `e2e-${unique()}`, subject, to: 'someone@example.com', status: 'queued', sentAt: null, createdAt: new Date().toISOString() };
  await page.route(/\/api\/emails(\?|$)/, route => route.request().method() === 'GET'
    ? route.fulfill({ json: { data: [email], meta: { total: 1, page: 1, limit: 25, pages: 1 } } })
    : route.fallback());
  await page.route(`**/api/emails/${email.id}`, route => route.fulfill({ json: email }));

  await signIn(page); await page.goto('/app/emails');
  const row = page.getByRole('row').filter({ hasText: subject });
  await expect(row.getByText('not sent', { exact: true })).toBeVisible();
  await expect(row.getByText('queued', { exact: true })).toHaveCount(0);

  await row.getByText(subject).click();
  const detail = page.getByRole('main').getByRole('heading', { name: subject });
  await expect(detail).toBeVisible();
  await expect(page.getByRole('main').getByText('not sent', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText('queued', { exact: true })).toHaveCount(0);
});
