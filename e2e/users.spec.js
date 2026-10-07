const { test, expect } = require('@playwright/test');

const unique = () => Math.random().toString(36).slice(2, 10);
async function signIn(page, email = 'pilot-admin@example.com', password = 'Pilot-admin-123!') {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: /^Sign In$/i }).click();
  await expect(page.locator('#main-content')).toBeVisible();
}
const signInStatus = async (request, email, password) => (await request.post('/api/auth/login', { data: { email, password } })).status();
/** The link in the newest mail to `to`, with its quoted-printable encoding undone. */
async function linkMailedTo(request, to, path) {
  const mail = await (await request.get('/__test/mail')).json();
  const content = mail.filter(m => m.to.includes(to)).pop().content.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  return content.match(new RegExp(`https?://[^\\s"<>]*${path}\\?token=[A-Za-z0-9._%-]+`))[0];
}

test('invite someone, deactivate and reactivate them, and send them a password reset', async ({ page, request, browser }) => {
  const suffix = unique(); const email = `teammate-${suffix}@example.org`; const name = `Robin ${suffix}`;
  await signIn(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Users', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  await expect(page.getByRole('listitem', { name: /Administrator/ }).getByText('You', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Invite user' }).click();
  const inviteDialog = page.getByRole('dialog', { name: 'Invite user' });
  await inviteDialog.getByLabel(/^Email/).fill(email);
  await inviteDialog.getByLabel('First name').fill('Robin'); await inviteDialog.getByLabel('Last name').fill(suffix);
  await inviteDialog.getByLabel('Role').selectOption({ label: 'Sales Rep' });
  await inviteDialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(`Invite emailed to ${email}`)).toBeVisible();
  const invited = page.getByRole('listitem', { name });
  await expect(invited.getByText('Sales Rep', { exact: true })).toBeVisible();

  // They accept from the emailed link and are in.
  const newcomer = await browser.newContext({ baseURL: new URL(page.url()).origin }); const theirs = await newcomer.newPage();
  await theirs.goto(await linkMailedTo(request, email, '/accept-invite'));
  await theirs.getByLabel('Password', { exact: true }).fill('Teammate-password-1!');
  await theirs.getByLabel('Confirm password', { exact: true }).fill('Teammate-password-1!');
  await theirs.getByRole('button', { name: /Create account|Join|Set password|Accept invite/i }).click();
  await expect(theirs.locator('#main-content')).toBeVisible();

  await page.reload();
  const member = page.getByRole('listitem', { name });
  await expect(member.getByText('Sales Rep', { exact: true })).toBeVisible();
  await expect(member.getByText(/Last signed in/)).toBeVisible();

  // Deactivated, they are out at once: their open session and any new sign-in.
  await member.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await page.getByRole('dialog', { name: 'Deactivate user' }).getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(page.getByText(`${name} is deactivated`)).toBeVisible();
  await expect(page.getByRole('listitem', { name })).toHaveCount(0);
  expect((await newcomer.request.get('/api/contacts')).status()).toBe(403);
  expect(await signInStatus(request, email, 'Teammate-password-1!')).not.toBe(200);

  await page.getByRole('button', { name: /^Deactivated/ }).click();
  await page.getByRole('listitem', { name }).getByRole('button', { name: 'Reactivate', exact: true }).click();
  await expect(page.getByText(`${name} can sign in again`)).toBeVisible();
  expect(await signInStatus(request, email, 'Teammate-password-1!')).toBe(200);

  // A reset link, emailed: it sets a new password, and the old one stops working.
  await page.getByRole('button', { name: /^Active/ }).click();
  await page.getByRole('listitem', { name }).getByRole('button', { name: 'Send password reset' }).click();
  await page.getByRole('dialog', { name: 'Send password reset' }).getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(`Password reset link emailed to ${email}`)).toBeVisible();
  await theirs.goto(await linkMailedTo(request, email, '/reset-password'));
  await theirs.getByLabel('New password').fill('Teammate-password-2!');
  await theirs.getByLabel('Confirm password').fill('Teammate-password-2!');
  await theirs.getByRole('button', { name: 'Update password' }).click();
  await expect(theirs.getByText(/Password updated/)).toBeVisible();
  expect(await signInStatus(request, email, 'Teammate-password-2!')).toBe(200);
  expect(await signInStatus(request, email, 'Teammate-password-1!')).not.toBe(200);
  await newcomer.close();
});

test('the only administrator is told why they cannot step down', async ({ page }) => {
  await signIn(page); await page.goto('/app/users');
  await page.getByRole('listitem', { name: /Administrator/ }).getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Edit / });
  await expect(dialog.getByLabel('Email')).toBeDisabled();
  await dialog.getByLabel('Role').selectOption({ label: 'Manager' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('This is the only active administrator. Make someone else an administrator first.')).toBeVisible();
});

test('a read-only user sees the team but cannot change it', async ({ page }) => {
  await signIn(page, 'pilot-reader@example.com', 'Pilot-reader-123!'); await page.goto('/app/users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  await expect(page.getByRole('listitem', { name: /Administrator/ })).toBeVisible();
  await expect(page.getByText('You can see users; managing them takes permission to manage users.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite user' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Edit|Deactivate|Send password reset)$/ })).toHaveCount(0);
});

test('the users screen fits a phone', async ({ page }) => {
  await signIn(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/app/users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  expect(await page.locator('#main-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
