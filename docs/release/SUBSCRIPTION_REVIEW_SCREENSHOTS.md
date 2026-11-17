# Resqlo subscription review screenshots

Capture these from the native iOS **Plans & Billing** screen. Apple uses them for review, not for the public listing. Do not reuse `mobile/appstore/screenshots/` or the browser screenshot generator: they do not show the native Apple subscription offering.

## Capture on an iPhone

1. Install the TestFlight build that matches the intended submission. Record its build number and iPhone model privately. An older beta is useful for rehearsal but does not establish that the final build shows the same offers.
2. Sign in with a dedicated Free test account containing only sample data. Turn on Do Not Disturb to keep notifications out of the shot. If available, choose **Settings → General → Screen Capture → SDR** to save PNG screenshots.
3. Open **More → Plans & Billing**. Confirm the Apple subscription cards load. If it shows **Plans are unavailable**, stop and ask the release owner to check the build's RevenueCat setup, offerings and StoreKit availability. Do not substitute a Stripe screen, mockup or manually typed price.
4. Scroll to each plan and take a full-screen portrait screenshot showing the plan title, Apple-provided price and billing period, and its subscribe/trial action. Use the volume-up and side buttons. No purchase or restore is needed. Save the original PNGs with these exact names:

| Product ID | Card to show | Filename |
| --- | --- | --- |
| `com.vendora.pro.monthly` | **Pro**, price per month | `com.vendora.pro.monthly.png` |
| `com.vendora.pro.yearly` | **Pro**, price per year | `com.vendora.pro.yearly.png` |
| `com.vendora.partner.monthly` | **Pro + Partner**, price per month | `com.vendora.partner.monthly.png` |

## Preflight and handoff

- Transfer the three originals without resizing, cropping, or converting to JPEG. Put them in `.app-review/subscriptions/` at the repo root (gitignored), or use a private folder outside the repo. Don't commit, paste into a public PR, or share any image showing personal data. Visually check each image against the table.
- From the repo root with Node 22.2 or newer, run:

  ```sh
  node docs/release/check-subscription-review-screenshots.mjs
  # Or pass a private capture folder:
  node docs/release/check-subscription-review-screenshots.mjs "path/to/screenshots"
  ```

- The preflight checks three expected names, PNG structure, no transparency, and these example portrait dimensions: iPhone 15 / 15 Pro (1179 × 2556), iPhone 15 Plus / 15 Pro Max (1290 × 2796), and iPhone 16 Pro Max (1320 × 2868). It intentionally doesn't list every device Apple accepts. If using another model, confirm its original dimensions in [Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications) and add that verified pair to the checker, or manually verify the originals against Apple's specs. Don't resize an image to pass the check.
- A pass does not prove the picture is native, that the correct plan and price appear, or that Apple will accept it. The release owner should confirm each file visually and privately. In **App Store Connect → Apps → Resqlo**, open **Subscriptions** under **Monetization**, select **Resqlo Pro** and the matching product, then upload its file under **Review Information → Screenshot**. The script does not upload or submit anything.

[Apple: App Review screenshot requirements](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information) · [Apple: SDR capture settings](https://support.apple.com/guide/iphone/change-the-screen-capture-settings-iph2d2500abc/ios)

Maintainers can run the checker regression tests without installing app dependencies:

```sh
node --test docs/release/check-subscription-review-screenshots.test.mjs
```
