/**
 * Capture screenshots of the main screens from the static web build with a
 * mocked API (no backend needed).
 *
 *   npx expo export --platform web --output-dir dist
 *   npx serve dist -p 3001 --no-clipboard   (separate shell)
 *   node scripts/ui-screenshots.mjs <outDir>
 */
import { chromium, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] || "../docs/readiness/ui-refresh/after";
const base = process.env.BASE_URL || "http://localhost:3001";
fs.mkdirSync(outDir, { recursive: true });

const now = new Date().toISOString();
const user = {
  id: "u1", email: "demo@vendora.app", business_name: "Kicks & Co", profile_picture: null,
  business_address: null, business_phone: null, invoice_accent_color: null,
  subscription_tier: "pro", is_partner: false, created_at: now, updated_at: now,
};
const mk = (i, name, cat, buy, sell, status, qty) => ({
  id: `i${i}`, user_id: "u1", name, category: cat, sku: `SKU-${100 + i}`, upc: null, size: "10",
  color: null, condition: "New", serial_number: null, custom_attributes: null, buy_price: buy,
  expected_sell_price: sell, actual_sell_price: null, platform: null, status, photo_front_url: null,
  photo_back_url: null, quantity: qty, vendor_name: null, notes: null, source: null, external_id: null,
  created_at: now, updated_at: now,
});
const items = [
  mk(1, "Air Jordan 1 Retro High OG", "Sneakers", "180.00", "320.00", "in_stock", 2),
  mk(2, "Nike Dunk Low Panda", "Sneakers", "110.00", "165.00", "listed", 1),
  mk(3, "Supreme Box Logo Hoodie", "Apparel", "168.00", "450.00", "in_stock", 1),
  mk(4, "New Balance 550 White Green", "Sneakers", "90.00", "140.00", "sold", 0),
];
const dashboard = {
  revenue_today: "320.00", revenue_week: "1240.00", revenue_month: "4875.50",
  net_profit_today: "140.00", net_profit_week: "512.00", net_profit_month: "1930.25",
  net_profit_all_time: "8420.00", total_inventory_value: "2140.00", total_expected_value: "3560.00",
  potential_profit: "1420.00", total_items: 4, items_in_stock: 2, items_listed: 1, items_sold: 1,
  total_transactions: 18, total_refunds: 1,
};
const page = (list) => ({ items: list, total: list.length, page: 1, per_page: 50, pages: 1 });

function handler(empty) {
  return async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^.*\/api\/v1/, "");
    let body = {};
    if (p === "/auth/me") body = user;
    else if (p === "/dashboard") body = empty ? { ...dashboard, total_items: 0, items_in_stock: 0, items_listed: 0, items_sold: 0 } : dashboard;
    else if (p === "/inventory") body = page(empty ? [] : items);
    else if (p.startsWith("/inventory/") && !p.includes("/", 11)) body = items.find((x) => p.endsWith(x.id)) || items[0];
    else if (p.startsWith("/transactions") || p.startsWith("/invoices")) body = page([]);
    else if (p === "/features") body = { tier: "pro", is_partner: false, features: {} };
    else if (p.includes("/sync-runs")) body = [];
    else if (p === "/integrations/health") body = { providers: [] };
    else if (p.endsWith("/status")) body = { connected: false };
    else if (p.endsWith("/activity")) body = [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  };
}

const shots = [
  ["dashboard", "/dashboard"],
  ["inventory", "/inventory"],
  ["add-stock", "/inventory/add"],
  ["quick-sale", "/inventory/sale"],
  ["more", "/more"],
  ["settings", "/settings"],
  ["sync-center", "/settings/sync-center"],
  ["invoices", "/inventory/invoices"],
];

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {},
);
for (const empty of [false, true]) {
  const ctx = await browser.newContext({ ...devices["iPhone 12"] });
  await ctx.route(/\/api\/v1\//, handler(empty));
  await ctx.addInitScript(() => {
    localStorage.setItem("vendora_access_token", "demo");
    localStorage.setItem("vendora_refresh_token", "demo");
  });
  const pg = await ctx.newPage();
  for (const [name, route] of empty ? shots.slice(0, 2) : shots) {
    await pg.goto(base + route);
    await pg.waitForTimeout(2500);
    await pg.screenshot({ path: path.join(outDir, `${name}${empty ? "-empty" : ""}.png`) });
  }
  await ctx.close();
}
const ctx = await browser.newContext({ ...devices["iPhone 12"] });
const pg = await ctx.newPage();
await pg.goto(base + "/");
await pg.waitForTimeout(2500);
await pg.screenshot({ path: path.join(outDir, "login.png") });
await browser.close();
console.log("saved to", outDir);
