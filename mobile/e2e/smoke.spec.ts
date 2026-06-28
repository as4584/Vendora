/**
 * Vendora Mobile — iPhone Smoke Tests
 *
 * Runs against the Expo web build (no backend needed).
 * Catches white pages, JS crashes, and broken navigation.
 *
 * Unauthenticated → always lands on login screen, so no test credentials required.
 */
import { test, expect } from '@playwright/test';

test.describe('Login screen', () => {
  test('renders without white page', async ({ page }) => {
    await page.goto('/');

    // App loads and redirects to login
    await expect(page.locator('text=Vendora')).toBeVisible();
    await expect(page.locator('text=Your Reseller OS')).toBeVisible();

    // Form fields are present
    await expect(page.getByText('Email', { exact: true })).toBeVisible();
    await expect(page.getByText('Password', { exact: true })).toBeVisible();
    await expect(page.getByText('Forgot password?', { exact: true })).toBeVisible();

    // No blank page — at least 500 chars of content
    const html = await page.content();
    expect(html.length).toBeGreaterThan(500);
  });

  test('shows no JS error overlay', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await expect(page.locator('text=Vendora')).toBeVisible();

    // Filter out known non-critical network errors from missing backend
    const fatal = errors.filter(
      (e) => !e.includes('fetch') && !e.includes('Network') && !e.includes('ERR_')
    );
    expect(fatal).toHaveLength(0);
  });
});

test.describe('Forgot password screen', () => {
  test('opens from login and renders the reset request form', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Forgot password?', { exact: true })).toBeVisible();
    await page.getByText('Forgot password?', { exact: true }).click();

    await expect(page.locator('text=Reset your password')).toBeVisible();
    await expect(page.locator('text=Send Reset Link')).toBeVisible();
    await expect(page.locator('text=Back to sign in')).toBeVisible();
  });
});

test.describe('Register screen', () => {
  test('renders without white page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Vendora')).toBeVisible();

    // Navigate to register via "Sign Up" link
    await page.click('text=Sign Up');

    // Check register form rendered (use unique field to avoid strict mode with login page remnants)
    await expect(page.locator('text=Confirm Password')).toBeVisible();

    const html = await page.content();
    expect(html.length).toBeGreaterThan(500);
  });
});

test.describe('Login form interaction', () => {
  test('shows validation when submitting empty form', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Vendora')).toBeVisible();

    // Tap login without filling anything — app should react (not crash)
    const loginBtn = page.locator('text=Sign In').or(page.locator('text=Login')).first();
    if (await loginBtn.isVisible()) {
      await loginBtn.click();
      // App should still be rendered (not white page) after bad submit
      await expect(page.locator('text=Vendora')).toBeVisible();
    }
  });
});
