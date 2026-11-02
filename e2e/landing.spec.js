const { test, expect } = require('@playwright/test');
test.beforeEach(async ({ page }) => { await page.route('**/api/marketing/events', route => route.fulfill({ status: 204 })); });

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
  await navigation.getByRole('link', { name: 'Product', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(/#product$/);
  await expect.poll(async () => (await page.locator('#product').boundingBox()).y).toBeGreaterThanOrEqual(72);
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
  await expect(page.locator('.sn-form-success')).toContainText('Check your inbox.');
  await expect(page.locator('.sn-form-success')).toBeFocused();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ firstName: 'Taylor', lastName: 'Example', email: 'taylor@example.org', company: 'Example Company', companySize: '11-50', interestedIn: 'self-hosted', useCase: 'Spreadsheets', source: 'landing' });
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
  await expect(page.getByRole('region', { name: 'Guided product tour' })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/leads\/demo-lead-1$/);
  await expect(page.locator('#main-content')).toBeVisible();
  await page.goto('/verify');
  await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
  await page.goto('/accept-invite');
  await expect(page.getByRole('heading', { name: 'Invite not valid' })).toBeVisible();
});

test('the one-click tour follows real sample records without an authentication or CRM API call', async ({ page }) => {
  const liveRequests = [], events = [], errors = [];
  page.on('request', request => { if (/\/api\/(auth|leads|deals|quotes)\b/.test(request.url())) liveRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('[ui:error-boundary]')) errors.push(message.text()); });
  await page.route('**/api/marketing/events', route => { events.push(route.request().postDataJSON()); return route.fulfill({ status: 204 }); });
  await page.goto('/?utm_source=newsletter&utm_medium=email&utm_campaign=launch');
  await page.getByRole('link', { name: 'Explore the demo', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Anna', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'TechStart team rollout', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Product lines', exact: true })).toContainText('24,000');
  await expect(page.getByRole('button', { name: 'Download quote PDF', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview quote', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Quote document"]').getByRole('heading', { name: 'TechStart rollout proposal' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Finish tour', exact: true }).click();
  await expect(page.getByText('Tour complete. Your next move is yours.')).toBeVisible();
  await expect.poll(() => events.filter(e => e.event === 'demo_start').length).toBe(1);
  await expect.poll(() => events.filter(e => e.event === 'tour_complete').length).toBe(1);
  expect(events.find(e => e.event === 'demo_start')).toMatchObject({ utmSource: 'newsletter', utmCampaign: 'launch' });
  expect(liveRequests).toEqual([]); expect(errors).toEqual([]);
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Not signed in' } }));
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('sn_demo_mode'))).toBeNull();
});

test('hosting choice, campaign attribution, resend and request status connect the public journey', async ({ page }) => {
  let payload;
  await page.route('**/api/signup', route => { payload = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { accepted: true, message: 'Check your inbox.' } }); });
  await page.route('**/api/signup/resend', route => route.fulfill({ status: 202, json: { message: 'If pending, a new verification link is on its way.' } }));
  await page.goto('/hosting?utm_source=partner&utm_campaign=launch');
  await page.getByRole('link', { name: 'Discuss a self-hosted rollout' }).click();
  await expect(page.getByLabel('Deploy preference')).toHaveValue('self-hosted');
  await expect(page).toHaveURL(/hosting=self-hosted#access$/);
  await page.getByLabel('Work email').fill('new@example.org');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.locator('.sn-form-success')).toBeVisible();
  expect(payload).toMatchObject({ utmSource: 'partner', utmCampaign: 'launch', interestedIn: 'self-hosted' });
  expect(payload.marketingVisitId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Resend verification email' }).click();
  await expect(page.getByRole('button', { name: /Resend in/ })).toBeDisabled();
  await page.getByRole('link', { name: 'Check your request status' }).click();
  await expect(page.getByRole('form', { name: 'Email a status link' })).toBeVisible();
});

test('verification and emailed status proofs work without exposing the proof in the URL', async ({ page }) => {
  const proofs = [];
  await page.route('**/api/signup/verify', route => route.fulfill({ json: { verified: true, statusToken: 'private-proof', message: 'Your email is confirmed.' } }));
  await page.route('**/api/signup/status', route => { proofs.push(route.request().postDataJSON().token); return route.fulfill({ json: { status: 'Approved', verified: true, invite: { status: 'Pending', expired: true } } }); });
  await page.goto('/verify?token=verification-only');
  await page.getByRole('button', { name: 'View request status' }).click();
  await expect(page.getByRole('heading', { name: 'Your invitation is ready.' })).toBeVisible();
  await expect(page.getByText(/Contact the administrator who sent it/)).toBeVisible();
  await page.goto('/access-status#token=emailed-proof');
  await expect.poll(() => proofs.includes('emailed-proof')).toBe(true);
  await expect(page).toHaveURL(/\/access-status$/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await page.route('**/api/signup/status', route => route.fulfill({ status: 401, json: { error: 'This status link is invalid or expired.' } }));
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('form', { name: 'Email a status link' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('expired');
});

test('privacy choice and browser privacy signals stop new measurements', async ({ page }) => {
  const events = [];
  await page.route('**/api/marketing/events', route => { events.push(route.request().postDataJSON()); return route.fulfill({ status: 204 }); });
  await page.goto('/');
  await expect.poll(() => events.length).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await page.getByRole('checkbox', { name: /Allow website conversion/ }).uncheck();
  const before = events.length;
  await page.goto('/hosting');
  await page.getByRole('link', { name: 'Discuss hosting', exact: true }).click();
  await page.getByLabel('Work email').fill('privacy@example.org');
  expect(events.length).toBe(before);
  await page.addInitScript(() => { localStorage.removeItem('sn_measurement_opt_out'); Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }); });
  await page.goto('/tour');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(events.length).toBe(before);
});

test('public pages are prerendered and have distinct canonical metadata without JavaScript', async ({ browser, request, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    for (const [path, title] of [['/', 'Keep your next win in sight.'], ['/hosting', 'Choose howyou run your Nebula.'], ['/tour', 'Three steps.One connected story.'], ['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service']]) {
      const response = await page.goto(path);
      expect(response.status()).toBe(200);
      await expect(page.locator('h1')).toHaveText(title);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://salesnebula.com${path}`);
      expect(await page.locator('#root').getAttribute('data-prerender')).toBe(path);
    }
    const sitemap = await request.get('/sitemap.xml'); expect(await sitemap.text()).toContain('https://salesnebula.com/tour');
    for (const path of ['/demo', '/access-status', '/app/leads/any']) {
      const response = await request.get(path); expect(response.status()).toBe(200);
      expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
      expect(await response.text()).toContain('<div id="root"></div>');
    }
    expect((await request.get('/does-not-exist')).status()).toBe(404);
  } finally { await context.close(); }
});

test('walkthrough images load and public pages fit narrow screens after hydration', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const path of ['/hosting', '/tour', '/access-status']) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (path === '/tour') {
        for (const image of await page.locator('figure img').all()) { await image.scrollIntoViewIfNeeded(); await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth === 1280)).toBe(true); }
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.screenshot({ path: testInfo.outputPath(`${path.slice(1)}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test('reviewers can inspect campaign conversion and performance cohorts', async ({ page }) => {
  const periods = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 'reviewer', firstName: 'Sample', lastName: 'Reviewer', email: 'reviewer@example.org', role: { name: 'Admin', permissions: [{ module: 'users', level: 'full' }] } } } });
    if (url.pathname === '/api/marketing/summary') {
      periods.push(url.searchParams.get('days'));
      return route.fulfill({ json: { funnel: { visits: 100, demos: 30, tours: 12, forms: 20, requested: 15, verified: 10, activated: 4 }, sources: [{ source: 'newsletter', medium: 'email', campaign: 'launch', visits: 100, demos: 30, requests: 15, activated: 4 }], performance: [{ page: '/', device: 'mobile', metrics: { lcpMs: { p75: 2100, samples: 90 }, inpMs: { p75: 170, samples: 40 }, cls: { p75: 0.05, samples: 85 } } }] } });
    }
    return route.fulfill({ json: { data: [], total: 0, invitations: [] } });
  });
  await page.goto('/app/accessRequests');
  await page.locator('summary').filter({ hasText: 'Website conversion, activation & performance' }).click();
  await expect(page.getByRole('table', { name: 'Acquisition sources' })).toContainText('newsletter / email');
  await expect(page.getByRole('table', { name: /Public-page performance/ })).toContainText('2100 ms (90)');
  await page.getByLabel('Measurement period').selectOption('7');
  await expect.poll(() => periods.includes('7')).toBe(true);
  await expect(page.getByText(/Verification and first sign-in come from approved access requests/)).toBeVisible();
});
