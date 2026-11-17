import { expect, test, type Page } from "@playwright/test";
import fixtures from "./visual/fixtures.json";

const token = (owner: string) => `x.${Buffer.from(JSON.stringify({ sub: owner, sid: owner })).toString("base64url")}.x`;
const buyer = {
  id: "a-buyer", name: "Private Buyer A", email: "private-buyer-a@example.test",
  order_count: 1, total_spent: "24.00", last_purchase_at: null,
};

async function openMoreRoute(page: Page, title: "Customers" | "Settings") {
  await page.getByText("More", { exact: true }).click();
  await page.getByText(title, { exact: true }).click();
}

async function signIn(page: Page, owner: string) {
  await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("test-only-password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByText("More", { exact: true })).toBeVisible();
}

test("sign-out removes the private tab tree and B cannot see A's cached customers", async ({ page }) => {
  let customerNetworkUp = true;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const auth = route.request().headers().authorization;
    const owner = auth === `Bearer ${token("A")}` ? "A" : "B";
    const json = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path.endsWith("/auth/login")) {
      const id = route.request().postDataJSON().email.startsWith("A") ? "A" : "B";
      return json({ access_token: token(id), refresh_token: `test-refresh-${id}`, token_type: "bearer" });
    }
    if (path.endsWith("/auth/me")) {
      return auth
        ? json({ ...fixtures.me, id: owner, email: `${owner}@example.test` })
        : json({ detail: "Please sign in" }, 401);
    }
    if (path.endsWith("/customers")) {
      if (!customerNetworkUp) return route.abort("failed");
      return json({ items: owner === "A" ? [buyer] : [], total: owner === "A" ? 1 : 0 });
    }
    if (path.endsWith("/dashboard")) return json(fixtures.dashboard);
    if (path.endsWith("/inventory")) return json(fixtures.inventory);
    if (path.endsWith("/integrations/health")) return json({ providers: [] });
    return json({});
  });

  await page.goto("/");
  await signIn(page, "A");
  await openMoreRoute(page, "Customers");
  await expect(page.getByText(buyer.name)).toBeVisible();
  customerNetworkUp = false;

  await openMoreRoute(page, "Settings");
  await page.getByRole("button", { name: "Sign Out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeVisible();
  await expect(page.getByTestId("customers-content")).toHaveCount(0);
  await signIn(page, "B");
  await openMoreRoute(page, "Customers");
  await expect(page.getByTestId("customers-content")).toBeVisible();
  await expect(page.getByText(/failed to fetch/i)).toBeVisible();
  await expect(page.getByText(buyer.name)).toHaveCount(0);

  await openMoreRoute(page, "Settings");
  await page.getByRole("button", { name: "Sign Out", exact: true }).click();
  await signIn(page, "A");
  await openMoreRoute(page, "Customers");
  await expect(page.getByText(buyer.name)).toBeVisible();
});
