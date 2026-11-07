import { test, expect, type Page } from '@playwright/test';
import fixtures from './visual/fixtures.json';

async function openCheckout(page: Page, inventory: () => unknown | null, destination = '/inventory/sale') {
  await page.addInitScript(() => localStorage.setItem('vendora_access_token', 'local-test-token'));
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/auth/me') ? fixtures.me
      : path.endsWith('/inventory') ? inventory()
      : path.endsWith('/dashboard') ? fixtures.dashboard : [];
    return route.fulfill({ status: body === null ? 503 : 200, contentType: 'application/json', body: JSON.stringify(body ?? { detail: 'Temporarily unavailable' }) });
  });
  await page.goto('/');
  await expect(page.getByText('More', { exact: true })).toBeVisible();
  await page.evaluate(path => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, destination);
}

test('sale total and checkout stay on screen at both ends of the cart', async ({ page }) => {
  await openCheckout(page, () => fixtures.inventory, `/inventory/sale?add=${fixtures.item_id}`);
  await expect(page.getByText('Cart · 1 item')).toBeVisible();
  const checkout = page.getByRole('button', { name: /Log Sale/ });
  const bar = page.getByTestId('sale-checkout-bar');
  const assertPinned = async () => {
    await expect(checkout).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('sale-sticky-total')).toBeInViewport({ ratio: 1 });
    const rect = await bar.boundingBox();
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  };
  await assertPinned();
  const original = await bar.boundingBox();
  await page.getByText('Cart · 1 item').scrollIntoViewIfNeeded();
  await assertPinned();
  await page.getByRole('textbox', { name: 'Sale notes' }).scrollIntoViewIfNeeded();
  await assertPinned();
  expect((await bar.boundingBox())!.y).toBeCloseTo(original!.y, 0);
  await page.screenshot({ path: test.info().outputPath('sticky-checkout.png') });
});

test('failed inventory load recovers through retry rather than showing empty stock', async ({ page }) => {
  let failed = true;
  await openCheckout(page, () => failed ? null : fixtures.inventory);
  await expect(page.getByRole('alert')).toContainText("Couldn't load your stock");
  await expect(page.getByText("Table's empty — add stock to start a sale.")).toBeHidden();
  failed = false;
  await page.getByRole('button', { name: 'Try loading stock again' }).click();
  await expect(page.getByText('Nike Dunk Low Retro White Black', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toBeHidden();
  await page.getByRole('textbox', { name: 'Search sale inventory' }).fill('no-matching-item-123');
  await expect(page.getByText('No sellable items match that search.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByText('Nike Dunk Low Retro White Black', { exact: true })).toBeVisible();
});

test('empty stock has a clear next action on a small screen', async ({ page }) => {
  await openCheckout(page, () => ({ items: [], total: 0, page: 1, pages: 0, per_page: 100 }));
  await expect(page.getByText("Table's empty — add stock to start a sale.")).toBeVisible();
  await expect(page.getByTestId('sale-empty-add-stock')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('checkout-empty.png') });
  await page.getByTestId('sale-empty-add-stock').click();
  await expect(page.getByText('Scan a box', { exact: true })).toBeVisible();
});
