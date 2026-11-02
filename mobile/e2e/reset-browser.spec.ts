import { test, expect } from '@playwright/test';

test.skip(!process.env.VENDORA_RESET_BROWSER_TEST, 'Requires the local backend on port 18765');

test('browser reset validates input and reports successful submission', async ({ page }) => {
  let submitted: any;
  await page.route('**/api/v1/auth/reset-password', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
  });
  await page.goto(`http://127.0.0.1:18765/reset-password#token=${'a'.repeat(64)}`);
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel('New password').fill('NewPassword1');
  await page.getByLabel('Confirm password').fill('Different1');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('status')).toHaveText('Passwords do not match.');
  expect(submitted).toBeUndefined();
  await page.getByLabel('Confirm password').fill('NewPassword1');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('status')).toContainText('Your password has been reset');
  expect(submitted).toEqual({ token: 'a'.repeat(64), password: 'NewPassword1' });
  await expect(page.getByLabel('New password')).toBeHidden();
});

test('browser reset explains expired links', async ({ page }) => {
  await page.route('**/api/v1/auth/reset-password', route => route.fulfill({ status: 400 }));
  await page.goto(`http://127.0.0.1:18765/reset-password#token=${'a'.repeat(64)}`);
  await page.getByLabel('New password').fill('NewPassword1');
  await page.getByLabel('Confirm password').fill('NewPassword1');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('status')).toContainText('invalid or expired');
});
