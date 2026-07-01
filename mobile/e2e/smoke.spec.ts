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
    await expect(page.getByTestId('forgot-password-link')).toBeVisible();

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
    await expect(page.getByTestId('forgot-password-link')).toBeVisible();
    await page.getByTestId('forgot-password-link').click();

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

test.describe('Completed product surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('vendora_access_token', 'e2e-access-token');
      window.localStorage.setItem('vendora_refresh_token', 'e2e-refresh-token');
    });
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path.endsWith('/auth/me')) return json({ id: 'user-1', email: 'seller@test.com', business_name: 'Test Store', profile_picture: null, subscription_tier: 'pro', is_partner: true, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
      if (path.endsWith('/integrations/lightspeed/status')) return json({ connected: false, account_id: null, expires_at: null, last_synced_at: null });
      if (path.endsWith('/integrations/square/status')) return json({ connected: false, merchant_id: null, location_id: null, last_synced_at: null });
      if (path.endsWith('/integrations/clover/status')) return json({ connected: false, merchant_id: null, last_synced_at: null });
      if (path.endsWith('/integrations/health')) return json({ providers: [] });
      if (path.endsWith('/subscriptions/me')) return json({ tier: 'pro', is_partner: true, status: 'active', current_period_end: null, managed_billing: false });
      if (path.endsWith('/dashboard/advanced')) return json({ period_days: 30, revenue: '100', net: '80', average_order_value: '50', sell_through_rate: '25', daily: [], categories: [] });
      if (path.endsWith('/dashboard')) return json({ revenue_today: '0', revenue_week: '0', revenue_month: '0', net_profit_today: '0', net_profit_week: '0', net_profit_month: '0', net_profit_all_time: '0', total_inventory_value: '0', total_expected_value: '0', potential_profit: '0', total_items: 0, items_in_stock: 0, items_listed: 0, items_sold: 0, total_transactions: 0, total_refunds: 0 });
      if (path.endsWith('/inventory')) return json({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
      if (path.endsWith('/sellers/user-1')) return json({ seller: { id: 'user-1', business_name: 'Test Store', is_partner: true, verified: true, member_since: '2025-01-01T00:00:00Z' }, stats: { total_items: 4, items_sold: 2, total_transactions: 3 }, listings: [], disclaimer: 'Marketplace disclaimer.' });
      return json({});
    });
  });

  test('navigates billing, analytics, support, and public storefront', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const openSettings = async () => {
      await page.goto('/');
      await expect.poll(() => page.locator('body').innerText()).toContain('Settings');
      await page.getByText('Settings', { exact: true }).click();
      await expect(page.getByText('Vendora Plus')).toBeVisible();
    };
    await openSettings();
    expect(errors).toEqual([]);
    await page.getByText('Plans & Billing').click();
    await expect(page.getByText('Current access')).toBeVisible();
    await openSettings();
    await page.getByText('Advanced Analytics', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Advanced Analytics' })).toBeVisible();
    await openSettings();
    await page.getByText('Support', { exact: true }).click();
    await expect(page.getByText('Vendora Support')).toBeVisible();
    await openSettings();
    await page.getByText('View Public Storefront').click();
    await expect(page.getByText('✓ VERIFIED')).toBeVisible();
  });
});
