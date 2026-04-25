# Vendora Readiness

Date: 2026-04-25

## Result

- Backend tests: `338 passed`
- Mobile tests: `33 passed`
- Seeded account: `thegamermasterninja@gmail.com` on Pro tier
- Seeded inventory exported: `83` rows
- Export preview round-trip: `0 create / 83 update / 0 skip / 0 error`

## Runtime Checks

- Logged into the live seeded account through Expo web.
- Opened and visually checked: dashboard, inventory list, inventory detail, quick sale, invoices, settings, sync center, and import flow.
- Created one quick sale from inventory for `JBL Flip 6 Bluetooth Speaker` through the UI.
- Verified the JBL item showed reduced stock afterward (`Low stock 3` in inventory).
- Created one inventory-backed invoice for customer `QA`.
- Browser automation saw `0` console errors on the checked screens. The remaining browser warning is the React Native Web `pointerEvents` deprecation warning.

## Environment Note

- This machine already had an unrelated listener on port `8000`, so the live readiness run used Vendora backend port `8001`.
- Expo web during verification was launched with `EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:8001/api/v1`.
- The code default still points at `http://localhost:8000/api/v1` for normal local runs.

## Artifacts

- `inventory_seeded_export_2026-04-25.csv`
- `inventory_seeded_export_preview_2026-04-25.json`
- `inventory_seeded_export_summary_2026-04-25.json`
- `dashboard.png`
- `inventory-list.png`
- `inventory-detail-showcase.png`
- `inventory-after-quick-sale.png`
- `quick-sale.png`
- `quick-sale-selected.png`
- `invoices.png`
- `invoices-created.png`
- `settings.png`
- `sync-center.png`
- `import-flow.png`
