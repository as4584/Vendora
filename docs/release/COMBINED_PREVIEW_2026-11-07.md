# Combined Resqlo preview — 2026-11-07

Preview branch: `preview/big-update-20261107`. This is a local integration of PRs #72–#78 based on main `be31492`; no GitHub PR was merged and production was not deployed. Dependency-update PRs remain separate. Keep the original PRs available for review.

Additional polish: scan-to-cart acknowledgement, a short stock-count fade that always displays the actual quantity, receipt perforation detailing, and Expo Go purchase guards. Motion respects Reduce Motion. Native purchases and the custom VisionKit reader require a native build, not Expo Go.

Final hierarchy pass: More now groups destinations into Sales & customers, Business tools, and Account & help, with Show Summary as a featured action. Every destination has an explicit button role and label. Recovery screens use the shared graphite surface/border and text tokens. Updated localhost preview was inspected in the in-app browser. Post-change checks: 622 mobile tests (53 suites), typecheck, lint, web build, and 16 responsive browser layout checks passed (More/login/register/forgot-password at three iPhone widths and iPad). Native-device validation remains outstanding.

## Warm-light UI follow-up (unreleased)

- Removed the time-of-day greeting; the dashboard opens with Overview and a date.
- Labeled today's profit in UTC. The overview now says Last 30 days when advanced analytics is available, but This month when using calendar-month dashboard totals. Removed the nonfunctional period dropdown affordance and the 30-day sparkline from today's profit card. Identical totals can still be correct when all sales occurred today; no figures are fabricated to make periods look different.
- Replaced the graphite palette with warm off-white surfaces, dark ink, and a contrast-tested violet accent. Native appearance, navigation, status bar, splash configuration, auth forms, legacy editors, badges, camera hint plate, offline notices, and selected controls were checked for the theme transition. Native splash/icon configuration requires a new native build; Metro alone cannot change an already installed binary's launch screen.
- Added square ProductImage rendering with an accessible missing/broken-image fallback in the inventory list, item page, thumbnails, and quick sheet. No product photography was invented or sourced.
- Pinned the live sale total and Log Sale button below the cart's ScrollView without changing order submission, payment calculations, or idempotency. Existing receipt confirmation remains the success state.
- Put stock, asking price, condition, and sizes ahead of expandable cost/margin, metadata, invoices, and activity. Increased compact controls, quantity steppers, photo selectors, and the recovery link to 44pt targets; lighter labels leave emphasis on prices and quantities. Market pricing and Lightspeed actions use the shared busy state.
- Added regression checks for period fallback, failed-image recovery, expandable content, light launch configuration, contrast, offline notice states, compact targets, and checkout staying visible while scrolling. No new dependencies, schema changes, state transitions, production testing, merge, or deployment.

### Follow-up verification

- `npm ls --depth=0`: passed; installed dependency tree valid, no dependency changes.
- `npm run typecheck`, `npm run lint`: passed on final source.
- `npm run test:ci -- --silent`: 56 suites / 645 tests passed. Line coverage 96.75%, functions 95.04%, branches 87.38%; existing thresholds unchanged. This is not 100% coverage.
- `npm run build:web`: passed; the refreshed export is served by the existing sample-data localhost preview.
- `npx playwright test --reporter=line`: 149 passed / 133 skipped, twice. Skips remain duplicate layout cases in the second project plus four opt-in reset-browser cases; no physical iPhone execution is implied.
- After the final offline/selected-control contrast adjustments, rebuilt and ran `npx playwright test e2e/visual/layout.spec.ts --project='iPhone 12' --grep='show-summary|import-review' --reporter=line`: 15 passed. An additional `--grep='dashboard'` run passed seven normal/large-text checks. These are follow-up subsets, not a third full-suite pass.
- Latest localhost Expo iOS JavaScript bundle: SDK 57, HTTP 200, 9,359,738 bytes. Compilation is not a native-device test or a release.
- Manually inspected the built warm-light dashboard, inventory fallback, expandable metadata, and live sample-cart total staying visible at both scroll positions in the in-app browser. Did not submit a real sale or call external providers.
- Development failures were resolved before these final checks: mechanical color conversion JSX errors, an old source-label assertion that needed to open the new disclosure, caption contrast below 4.5:1, and a new test's Jest mock-hoisting error. No thresholds or assertions were weakened to hide a product failure.

## Combined checks (earlier baseline)

- Mobile `test:ci`: 53 suites / 621 tests passed; existing coverage gates unchanged. Additional assertions on scan acknowledgements subsequently passed in the 41-test checkout/motion/purchases subset.
- Mobile typecheck and lint passed. Web export passed. Expo Doctor: 21/21.
- Playwright: 147 passed / 133 skipped, no retries. Skips include duplicated layout cases in the second project and the opt-in reset-browser tests. These tests use simulated API responses, not provider/customer accounts.
- Backend: 1,215 passed and four temporary-directory permission setup errors. Rerunning `tests/test_web_app.py` with a fresh `--basetemp` passed all five tests (including the four errors). This was recovery across two runs, not a clean first full-suite pass.
- Backend Ruff passed. All migrations applied to a disposable local preview database; seeded demo account has 15 items, 3 customers, 3 sales and an invoice. Real localhost login/inventory smoke passed after correcting the test's expected fixture name.
- Expo Go iOS manifest served SDK 57; iOS bundle compiled and returned HTTP 200. No physical phone execution verified.

## Local preview

The current session leaves the sample-data web preview at `http://127.0.0.1:3002` and localhost Expo Metro at port 8082. These depend on this computer remaining on.

The sample account is `preview@resqlo.test`, password `LocalPreviewOnly!2026`. These are disposable localhost-only demo credentials, never production credentials. The web preview uses its separate `vendora_preview` database in the session-owned `resqlo-preview-test-db-20261107` container, loopback port 15433. Do not run the seed command against production.

The local Expo Go manifest currently uses the app's normal production API default. Phone testing there would use real business data. The custom native scanner is unavailable in Expo Go and barcode/manual entry remain the fallback; native subscriptions are unavailable there.

The automatic approval system rejected the public Expo tunnel command. No public Expo tunnel or phone-reachable QR was created. If the owner starts a tunnel manually after stopping the localhost Metro session, run from `mobile/`:

```powershell
npx expo start --go --tunnel --port 8082
```

Use the new QR emitted by that session. The localhost QR cannot reach the computer from a phone. This is an Expo Go development session, not an App Store/TestFlight build or production OTA.

## Still requires validation

- Physical iPhone: camera fallback, custom VisionKit in a native build, haptics, VoiceOver, native purchases/restores.
- Actual provider integration behavior, sandbox billing, account recovery, store metadata/configuration and owner approval for deployment.
- Off-computer uptime, independent monitoring, and restorable backups remain operational concerns; this preview does not resolve them.
- Hosting check: health endpoints passed; historical counters showed 38 origin request errors and 8 5xx responses; Cloudflare firewall-event inspection lacked its read-only token.
