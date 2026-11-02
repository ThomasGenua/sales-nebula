const { test, expect } = require('@playwright/test');

test('product preview supports keyboard tabs without moving the page', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Keep your next win in sight.');
  await expect(page.getByRole('tabpanel', { name: 'Pipeline', exact: true })).toContainText('$180,000');
  const before = await page.locator('.sn-preview-window').boundingBox();
  const pipeline = page.getByRole('tab', { name: 'Pipeline', exact: true });
  await pipeline.focus();
  await pipeline.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'My day', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'My day', exact: true })).toContainText('Discovery call with Northstar');
  await page.getByRole('tab', { name: 'My day', exact: true }).press('End');
  await expect(page.getByRole('tabpanel', { name: 'Revenue', exact: true })).toContainText('$16,000');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  const after = await page.locator('.sn-preview-window').boundingBox();
  expect(after.height).toBeCloseTo(before.height, 0);
  await page.getByRole('tab', { name: 'Revenue', exact: true }).press('Home');
  await expect(pipeline).toBeFocused();
  await expect(pipeline).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('mobile navigation closes on Escape, outside click, section choice and resize', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  await menu.click();
  await expect(navigation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(navigation).toBeHidden();
  await menu.click();
  await page.locator('.sn-preview-caption').click();
  await expect(navigation).toBeHidden();
  await menu.click();
  await navigation.getByRole('link', { name: 'Workflow', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(/#workflow$/);
  await expect.poll(async () => (await page.locator('#workflow-title').boundingBox()).y).toBeGreaterThanOrEqual(72);
  await menu.click();
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(navigation).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});

test('access request keeps entered data on an error, then confirms a successful retry', async ({ page }) => {
  const requests = [];
  let release;
  await page.route('**/api/signup', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await new Promise(resolve => { release = resolve; });
      return route.fulfill({ status: 503, contentType: 'text/html', body: 'Service unavailable' });
    }
    return route.fulfill({ status: 201, json: { accepted: true, message: 'Check your inbox for a verification link.' } });
  });
  await page.goto('/#access');
  await page.getByLabel('First name', { exact: true }).fill('Taylor');
  await page.getByLabel('Last name', { exact: true }).fill('Example');
  await page.getByLabel('Work email').fill('taylor@example.org');
  await page.getByLabel('Company', { exact: true }).fill('Example Company');
  await page.getByLabel('Company size').selectOption('11-50');
  await page.getByLabel('Deploy preference').selectOption('self-hosted');
  await page.locator('summary').filter({ hasText: 'Add a little context' }).click();
  await page.getByLabel('What are you replacing?').fill('Spreadsheets');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Work email')).toBeDisabled();
  await expect.poll(() => requests.length).toBe(1);
  release();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('Please try again');
  await expect(page.getByLabel('Work email')).toHaveValue('taylor@example.org');
  await expect(page.getByLabel('What are you replacing?')).toHaveValue('Spreadsheets');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox.');
  await expect(page.getByRole('status')).toBeFocused();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({ firstName: 'Taylor', lastName: 'Example', email: 'taylor@example.org', company: 'Example Company', companySize: '11-50', interestedIn: 'self-hosted', useCase: 'Spreadsheets', source: 'landing' });
});

test('email validation prevents empty requests and network failures remain retryable', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/signup', route => { attempts++; return route.abort('failed'); });
  await page.goto('/#access');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByLabel('Work email')).toBeFocused();
  expect(attempts).toBe(0);
  await page.getByLabel('Work email').fill('taylor@example.org');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  await expect(page.getByRole('button', { name: 'Submit request', exact: true })).toBeEnabled();
});

test('FAQ, skip link, reduced motion, legal links and access deep links work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  const faq = page.locator('summary').filter({ hasText: 'Can we run Sales Nebula ourselves?' });
  await faq.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Each installation serves one company/)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Each installation serves one company/)).toBeHidden();
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.locator('h1')).toContainText(/Privacy/i);
  await page.goto('/#access');
  await expect.poll(async () => (await page.locator('#access-title').boundingBox()).y).toBeGreaterThanOrEqual(88);
  await expect(page.getByRole('form', { name: 'Request access', exact: true })).toBeInViewport();
});

test('both themes fit phone, tablet and desktop widths', async ({ page }, testInfo) => {
  await page.goto('/');
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: 'Switch to light background' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const overflow = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll('.sn-site main :is(input, select, textarea, h1, h2, h3, .sn-site-button, .sn-preview-window):not(.sn-visually-hidden)')).filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width && (rect.right > viewport + 1 || rect.left < -1);
        }).map(element => element.outerHTML.slice(0, 100));
      });
      expect(overflow, `${theme}, ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: testInfo.outputPath(`landing-${theme}-${width}.png`), fullPage: true });
        await page.screenshot({ path: testInfo.outputPath(`landing-${theme}-${width}-hero.png`) });
      }
    }
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('demo and existing access pages remain reachable without a database', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Not signed in' } }));
  await page.goto('/');
  await page.getByRole('link', { name: 'Explore the demo', exact: true }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: 'Use demo access', exact: true }).click();
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('#main-content')).toBeVisible();
  await page.goto('/verify');
  await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
  await page.goto('/accept-invite');
  await expect(page.getByRole('heading', { name: 'Invite not valid' })).toBeVisible();
});
