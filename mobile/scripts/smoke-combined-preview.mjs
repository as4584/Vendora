// Smoke test against an owned, seeded localhost backend, never production.
import { chromium, expect } from '@playwright/test';
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:3002';
const url = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Local preview only');
if (!process.env.REVIEW_ACCOUNT_EMAIL || !process.env.REVIEW_ACCOUNT_PASSWORD) throw new Error('Local demo credentials required');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 }, reducedMotion: 'reduce' });
  await page.goto(base);
  await page.getByLabel('Email', { exact: true }).fill(process.env.REVIEW_ACCOUNT_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(process.env.REVIEW_ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByText('More', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, '', '/inventory');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText("Air Jordan 1 Retro High OG 'Chicago Lost & Found'", { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/combined-local-inventory.png', fullPage: true });
  console.log('Local seeded login and inventory smoke passed.');
} finally { await browser.close(); }
