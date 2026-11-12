import { test, expect } from '@playwright/test';
import fixtures from './visual/fixtures.json';

test('confirmed sale shows a readable receipt with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((sub) => {
    localStorage.setItem('vendora_access_token', `x.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.x`);
  }, fixtures.me.id);
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/auth/me') ? fixtures.me
      : path.endsWith('/inventory') ? fixtures.inventory
      : path.endsWith('/transactions/order') ? { order_id: 'receipt-test-order', transactions: [] }
      : path.endsWith('/dashboard') ? fixtures.dashboard : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.getByText('More', { exact: true })).toBeVisible();
  await page.evaluate(path => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/inventory/sale?add=${fixtures.item_id}`);
  await expect(page.getByText('Cart · 1 item')).toBeVisible();
  await page.getByRole('button', { name: 'Size 9, 1 in stock', exact: true }).click();
  await page.getByRole('button', { name: /Log Sale/ }).click();
  await expect(page.getByText('SOLD', { exact: true })).toBeVisible();
  await expect(page.getByText('Sale complete', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share receipt', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('receipt-reduced-motion.png') });
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
  await expect(page.getByText('SOLD', { exact: true })).toBeHidden();
});
