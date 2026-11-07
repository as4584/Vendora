/**
 * App Store screenshots for Resqlo.
 *
 * Renders six selling screens from the web build with the same stubbed,
 * server-shaped data as the visual layout gate (e2e/visual/fixtures.json),
 * at the two iPhone sizes App Store Connect asks for:
 *
 *   6.9"  1320 x 2868  (viewport 440 x 956  @3x)
 *   6.5"  1284 x 2778  (viewport 428 x 926  @3x)
 *
 * Usage (from mobile/):
 *   npm run build:web
 *   node scripts/appstore-screenshots.ts          # Node 22.18+/24 strips the types
 *
 * Output: appstore/screenshots/<size>/NN-<screen>.png (git-ignored when large;
 * upload them to App Store Connect by hand).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const PORT = Number(process.env.SCREENSHOT_PORT ?? 3011);
const BASE = `http://localhost:${PORT}`;
const OUT = join(ROOT, "appstore", "screenshots");
const fixtures = JSON.parse(readFileSync(join(ROOT, "e2e", "visual", "fixtures.json"), "utf8"));

export const SIZES = [
  { name: "6.9in", width: 440, height: 956, expect: [1320, 2868] },
  { name: "6.5in", width: 428, height: 926, expect: [1284, 2778] },
] as const;

type Shot = { name: string; path: string; ready?: string; steps?: (string | RegExp)[]; waitFor?: string | RegExp };

export const SHOTS: Shot[] = [
  { name: "01-dashboard", path: "/dashboard" },
  { name: "02-scan-add", path: "/inventory/add", ready: "Scan a box" },
  { name: "03-sale-cart", path: `/inventory/sale?add=${fixtures.item_id}`, ready: "Cart · 1 item", steps: ["10 · 1"] },
  {
    name: "04-receipt",
    path: `/inventory/sale?add=${fixtures.item_id}`,
    ready: "Cart · 1 item",
    steps: ["10 · 1", /^Log Sale/],
    waitFor: /receipt/i,
  },
  { name: "05-inventory", path: "/inventory", ready: "Nike Dunk Low" },
  { name: "06-show-summary", path: "/settings/show-summary", ready: "Count the cash box" },
];

const ORDER = {
  order_id: "c0ffee00-0000-4000-8000-000000000001",
  subtotal_amount: "165.00", discount_amount: "0.00", gross_amount: "165.00", tax_amount: "0.00",
  total_amount: "165.00", fee_amount: "0.00", net_amount: "165.00", payments: [], transactions: [],
};

const ROUTES: [RegExp, unknown][] = [
  [/\/transactions\/order$/, ORDER],
  [/\/auth\/me$/, fixtures.me],
  [/\/dashboard\/advanced/, fixtures.advanced],
  [/\/dashboard\/show-summary/, fixtures.show_summary],
  [/\/dashboard$/, fixtures.dashboard],
  [/\/inventory\/[^/?]+\/activity/, fixtures.item_activity],
  [new RegExp(`/inventory/${fixtures.item_id}$`), fixtures.item],
  [/\/inventory(\?|$)/, fixtures.inventory],
  [/\/transactions(\?|$)/, fixtures.transactions],
  [new RegExp(`/invoices/${fixtures.invoice_id}$`), fixtures.invoice],
  [/\/invoices(\?|$)/, fixtures.invoices],
  [/\/features\/tiers/, fixtures.tiers],
  [/\/features$/, fixtures.features],
  [/\/subscriptions\/me/, fixtures.subscription],
  [/\/integrations\/health/, fixtures.integrations_health],
  [/\/health$/, { status: "ok" }],
  [/\/scan\/memory/, []],
  [new RegExp(`/customers/${fixtures.customer_id}$`), fixtures.customer],
  [/\/customers(\?|$)/, fixtures.customers],
];

async function stubApi(page: Page) {
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    const hit = ROUTES.find(([re]) => re.test(url.pathname) || re.test(url.pathname + url.search));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hit ? hit[1] : []) });
  });
}

async function open(page: Page, shot: Shot) {
  await stubApi(page);
  await page.goto(BASE + "/");
  await page.evaluate(() => localStorage.setItem("vendora_access_token", "demo"));
  await page.goto(BASE + "/");
  await page.waitForLoadState("networkidle");
  const navigate = () =>
    page.evaluate((p) => {
      window.history.pushState({}, "", p);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, shot.path);
  await navigate();
  if (shot.ready) {
    const ready = page.getByText(shot.ready).first();
    try { await ready.waitFor({ state: "visible", timeout: 5_000 }); }
    catch { await navigate(); await ready.waitFor({ state: "visible", timeout: 15_000 }); }
  }
  for (const step of shot.steps ?? []) {
    await page.getByText(step, typeof step === "string" ? { exact: true } : undefined).first().click();
    await page.waitForTimeout(300);
  }
  if (shot.waitFor) await page.getByText(shot.waitFor).first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function waitForServer(url: string, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Static server did not start at ${url}. Did you run npm run build:web?`);
}

async function main() {
  const server: ChildProcess = spawn("npx", ["serve", "dist-web", "-p", String(PORT), "--no-clipboard"], {
    cwd: ROOT, shell: true, stdio: "ignore",
  });
  const browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {});
  const failures: string[] = [];
  try {
    await waitForServer(BASE);
    for (const size of SIZES) {
      const dir = join(OUT, size.name);
      mkdirSync(dir, { recursive: true });
      for (const shot of SHOTS) {
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "dark",
        });
        const page = await context.newPage();
        try {
          await open(page, shot);
          const file = join(dir, `${shot.name}.png`);
          await page.screenshot({ path: file });
          console.log(`ok   ${size.name}/${shot.name}.png (${size.expect.join("x")})`);
        } catch (error) {
          failures.push(`${size.name}/${shot.name}: ${(error as Error).message.split("\n")[0]}`);
          console.error(`FAIL ${size.name}/${shot.name}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}

if (process.argv[1] && /appstore-screenshots\.ts$/.test(process.argv[1])) {
  void main();
}
