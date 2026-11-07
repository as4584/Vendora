# Google Sheets sync

A seller can make a Google Sheet the source of truth for inventory. Resqlo reads and writes that sheet; the app is a UI over it.

Where to find it:

- **Settings → Google Sheets**: connect Google, create or link the sheet, Sync now, Open in Sheets, toggles, unlink and disconnect.
- **Import**: a "Keep a Google Sheet in sync instead" card.
- **Inventory, empty state** (first run, no filters): "Already track stock in a spreadsheet? Connect Google Sheets".
- **Sync Center**: Google Sheets is listed with the other providers. Its sync runs, failed row pushes (with Retry), sheet-wins notes and removed-row flags show up there.

## How it works

| Piece | What it does |
| --- | --- |
| OAuth | Authorization code flow with PKCE (S256) and scopes `https://www.googleapis.com/auth/drive.file openid email`. Tokens are Fernet-encrypted at rest (`google_tokens`). The signed `state` (JWT, 10 minutes) carries the user id, the return mode (web or native) and the encrypted PKCE verifier. |
| Link | One sheet tab per user (`google_sheet_links`): spreadsheet id, tab, header map, last-sync row snapshot, values hash, settings. |
| Pull (sheet to app) | Every 60 s, from the outbox sweep in the app lifespan, plus "Sync now". Reads the tab and applies it over the app. |
| Push (app to sheet) | Every app-side change (sale or refund through `deduct_stock`/`restore_stock`, quantity edits, item edits, new items) enqueues a `google_sheets / push_row` job in the shared `provider_outbox`. The job rewrites only the cells of that item's row that differ. Jobs coalesce per item, retry with exponential backoff, and show in Sync Center when they fail. |

### Columns

"Create a Resqlo sheet" makes a spreadsheet named **Resqlo Inventory** with one tab, **Inventory**. Its header row is frozen and uses the canonical export columns (`INVENTORY_EXPORT_COLUMNS` in `backend/app/services/csv_export.py`). Current inventory is written below the header.

Synced fields: name, category, sku, upc, size, color, condition, quantity, buy_price, expected_sell_price, actual_sell_price, status, platform, vendor_name, notes, photo_front_url, photo_back_url. The `id` column holds Resqlo's item id. The other canonical columns (formula, size breakdown, source, timestamps) are left blank and ignored.

For an existing sheet, the header row is mapped with the import alias logic (`resolve_field` in `services/spreadsheet_import.py`). For example "Item Name" maps to name, "Qty" to quantity and "Price" to the sell price. If the sheet has no `id` column, Resqlo adds one after the last header.

## Sheet-wins rules

Resqlo keeps a snapshot of every row as of the last sync. On each pull:

1. **Row with an id, or matched by UPC and then SKU**: if the sheet row changed since the snapshot, the sheet values are applied to the item. Quantity changes write a `sync` ledger entry and fan out to eBay and StockX like any other stock change.
2. **Both sides changed (conflict)**: the sheet wins. The run records which fields were overwritten, with both values, in `metadata.conflicts` and a "Sheet won over app edits on …" note. Each conflict also opens an info-level reconciliation issue so it shows in Sync Center.
3. **New row without an id**: a new item is created (source `google_sheets`) and its id is written back into the row.
4. **Row deleted from the sheet**: by default the item is flagged in Sync Center as a `missing_item` issue. With "Archive items deleted from the sheet" turned on, the item is archived (`status = archived`). Items are never hard-deleted.
5. **Item only in the app** (for example, added while pushes were failing): the item is appended as a new row.
6. **Pushes never overwrite sheet edits.** A push job first reads the row. If the seller edited it since the last sync, the push stops (`outcome: sheet_changed`) and the next pull applies the sheet.

**"Sheet is the source of truth" off**: the app keeps the sheet updated, but sheet edits are not pulled. A changed row gets a push that restores the app's values.

A blank `name` or `status` cell means "no opinion" and never clears the field. A blank quantity cell is read as 0.

## Safety and limits

- **Never writes formulas.** Every write uses `valueInputOption=RAW`, so Sheets never evaluates it. Text also goes through `safe_cell`: a value starting with `= + - @` is written with a leading apostrophe, which the importer strips again on read.
- **Rate limits.** A 429 is retried in-request up to 3 times, honouring `Retry-After` (capped at 60 s) or backing off exponentially. After that the outbox job backs off from 30 s up to 1 h, for at most 6 attempts, and Sync Center offers a manual Retry. A 401 refreshes the token once.
- **Quiet periodic sweeps.** A periodic pull that changes nothing records no run. A repeating failure records one failed run until the error message changes, plus `last_error` on the link.
- **User scoping.** Every query is filtered by the owner. A sheet row carrying another user's item id is treated as a new row and never touches that item (tested).
- **One sheet per user, one tab.** Pull reads the whole tab every ~60 s, which suits reseller-sized sheets (thousands of rows). The Sheets API read quota is 300 requests per minute per project and 60 per minute per user.
- **Tier limits are not enforced on sheet-created rows.**

### drive.file and existing sheets (important)

`drive.file` is a non-sensitive scope, so Resqlo does not need Google's restricted-scope security assessment. The trade-off: Resqlo can only open files it created, or files the user picked through a Google file picker opened by Resqlo.

- **Create a Resqlo sheet** is the recommended path, and the one the UI shows first.
- **Use an existing sheet** accepts a pasted link. It works for sheets Resqlo created, for example to re-link after unlinking. A sheet the seller made elsewhere returns a clear message: "Resqlo can't open that sheet… Create a Resqlo sheet instead, or import this one first and then create a Resqlo sheet."
- **Google Picker on web is not implemented yet.** It would grant drive.file access to an arbitrary existing sheet. It needs `GOOGLE_PICKER_API_KEY` (already a config key) and a small endpoint that hands the web client a short-lived access token. Until then, the workaround for an existing spreadsheet is: Import it (Import screen, link or file), then Create a Resqlo sheet.

## Owner setup

1. **Google Cloud project.** At https://console.cloud.google.com, create (or reuse) a project, for example `resqlo-prod`.
2. **Enable the APIs.** Under APIs and Services → Library, enable **Google Sheets API** and **Google Drive API** (both are enabled on the owner's project). Sheets does all the reads and writes; Drive is enabled for the `drive.file` grant and for the future web Picker.
3. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type: **External**.
   - App name **Resqlo**, support email, and the developer contact.
   - App domain: home page `https://vendora.lexmakesit.com`, privacy policy and terms URLs (the backend serves its legal pages). Authorized domain: `lexmakesit.com`.
   - Scopes (Data access → Add or remove scopes): `.../auth/drive.file`, `openid`, `.../auth/userinfo.email`. All three are non-sensitive.
   - **Test users**: while the app is in Testing / unverified, add each seller's Google account, up to 100. Refresh tokens for Testing apps expire after 7 days, so publish the app ("In production") for real use. With only non-sensitive scopes, publishing needs brand verification (domain ownership in Search Console), not a security assessment.
4. **OAuth client** (Clients → Create client):
   - Application type: **Web application**, name `Resqlo backend`.
   - Authorized redirect URI: `https://vendora.lexmakesit.com/api/v1/integrations/google/callback`
   - For local testing, also add `http://localhost:8000/api/v1/integrations/google/callback` and set `GOOGLE_REDIRECT_URI` to it locally.
   - No JavaScript origins are needed unless the web Picker is added later.
5. **Doppler** (project `lexmakesit`, config `prd`; see the `doppler-secret-ops` skill, since the CLI is broken on this machine):
   - `GOOGLE_CLIENT_ID`: the client ID (`….apps.googleusercontent.com`)
   - `GOOGLE_CLIENT_SECRET`: the client secret
   - `GOOGLE_REDIRECT_URI`: optional; defaults to the production URL above
   - The web return uses the shared `WEB_APP_URL` (default `https://vendora.lexmakesit.com`); nothing Google-specific to set.
   - `GOOGLE_PICKER_API_KEY`: reserved for the future web Picker; leave unset.
6. **Deploy and check.** After the backend restarts with the keys, `GET /api/v1/integrations/google/status` returns `configured: true`. Settings → Google Sheets → Connect Google → Create a Resqlo sheet.

Without the keys, every endpoint answers `503 Google Sheets not configured` and the card shows "Not configured". Without a connected account, the endpoints answer `409`.

## Return after Google sign-in

- **Native** (`platform=native`): the callback redirects to `vendora://settings?integration=google_sheets&status=connected|denied|error`, which closes the auth session.
- **Web** (`platform=web`): the callback returns a small page. If it was opened as a popup, it sends `{type: "resqlo-oauth", provider: "google_sheets", status}` to the opener with `postMessage`, restricted to the `WEB_APP_URL` origin, and writes a localStorage event, then closes. Otherwise it redirects to `https://vendora.lexmakesit.com/settings?integration=google_sheets&status=…`. The Settings card waits for that result and reloads. This is the shared return used by every provider: `backend/app/services/oauth_return.py` (`finish_response`) and `mobile/utils/oauthConnect.ts` (`openProviderConnect`).

## API

All routes are under `/api/v1/integrations/google`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/status` | configured, connected, email, linked sheet, pending and failed pushes |
| GET | `/connect?platform=web\|native` | authorization URL |
| GET | `/callback` | OAuth redirect target |
| DELETE | `` | revoke and disconnect; also unlinks the sheet and drops pending pushes |
| POST | `/sheet/create` | create the Resqlo sheet |
| POST | `/sheet/link` | `{url}`: link an existing sheet the token can open, then pull it |
| PATCH | `/sheet` | `{source_of_truth?, archive_missing?}` |
| DELETE | `/sheet` | unlink, keeping the sheet and the items |
| POST | `/sync` | pull now, then run pending pushes |

Shared Sync Center routes: `/integrations/sync-runs` (including `/{id}/retry`, which re-runs the pull), `/integrations/outbox?provider=google_sheets` and `/integrations/outbox/{id}/retry`.

Code: `backend/app/services/google_sheets.py`, `backend/app/routers/google_sheets.py`, `backend/app/models/google_sheets.py`, migration `033_google_sheets_sync.py`, `mobile/components/GoogleSheets.tsx`. Tests: `backend/tests/test_google_sheets_sync.py`, `mobile/__tests__/google-sheets.test.tsx`.
