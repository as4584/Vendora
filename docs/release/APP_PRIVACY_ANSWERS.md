# Resqlo 1.1 — App Store Connect "App Privacy" answers

Use this to fill in App Store Connect → App Privacy. It matches the privacy
manifest in `mobile/app.json` (`expo.ios.privacyManifests`).

**Does this app collect data?** Yes.
**Tracking?** No. There are no ads, no ad SDKs, no data brokers, and no IDFA. `NSPrivacyTracking = false`.
**Purpose for every type:** App Functionality only. Not Analytics, Advertising, Personalization, or Product Marketing.
**Linked to the user?** Yes for every type, because everything is stored under the seller's account.

| What the app handles | ASC category → data type | Collected? | Linked | Tracking | Purpose / notes |
|---|---|---|---|---|---|
| Account email | Contact Info → Email Address | Yes | Yes | No | Sign-in, password reset |
| Business name, seller name | Contact Info → Name | Yes | Yes | No | Invoices and receipts |
| Customer names (the seller's buyers) | Contact Info → Name | Yes | Yes | No | Customer list, invoices |
| Customer emails | Contact Info → Email Address | Yes | Yes | No | Sending invoices |
| Customer phones | Contact Info → Phone Number | Yes | Yes | No | Customer records |
| Customer and business address | Contact Info → Physical Address | Yes | Yes | No | Invoices |
| Resqlo user id (also the RevenueCat app user id) | Identifiers → User ID | Yes | Yes | No | Account, subscription entitlement |
| Subscription status, plus the seller's sales and invoices | Purchases → Purchase History | Yes | Yes | No | Pro access, sales records, show summary |
| Item and profile photos | User Content → Photos or Videos | Yes | Yes | No | Only photos the user picks or takes |
| Support requests | User Content → Customer Support | Yes | Yes | No | Support tickets |
| Inventory, prices, notes, invoices | User Content → Other User Content | Yes | Yes | No | Core app data |
| Barcode/label text from the camera | — | **Not collected** | — | — | Processed on the device. Only the resulting item fields are saved, and those are counted as user content above |
| Crash/diagnostic data | Diagnostics | **Not collected** | — | — | There is no crash or analytics SDK. Re-check this if Sentry or a similar tool is added |
| Payment card numbers | Financial Info → Payment Info | **Not collected** | — | — | Apple handles iOS subscriptions. Stripe is used on the web only, and card data goes straight to Stripe |
| Location, contacts, health, browsing history, search history, sensitive info | — | Not collected | — | — | |

## Third-party connections (all started by the user, all OAuth)

| Service | What Resqlo stores | Removed on account deletion |
|---|---|---|
| eBay | Encrypted OAuth tokens, listing/order data | Tokens deleted. Listing data is removed when the user's rows are deleted |
| StockX | Encrypted OAuth tokens, ask data | Tokens deleted |
| Google Sheets | Encrypted OAuth tokens, linked sheet id | Token **revoked at Google**, then deleted |
| Square / Clover / Lightspeed | Encrypted credentials, synced item links | Deleted |
| RevenueCat (Apple IAP) | App user id = Resqlo user id, entitlement | The customer record is deleted when `REVENUECAT_SECRET_KEY` is set. The user cancels their Apple subscription in Apple ID settings, and the app tells them so |
| Stripe (web only) | Customer and subscription ids | The subscription is cancelled before deletion |

Data from these services is used only to provide app features. It is not shared for any other purpose.

Required-reason APIs declared in the manifest (used by Expo SDK 57 modules and React Native):
UserDefaults `CA92.1`, FileTimestamp `0A2A.1 3B52.1 C617.1`, DiskSpace `E174.1 85F4.1`, SystemBootTime `35F9.1`.
RevenueCat (`react-native-purchases`) ships its own privacy manifest.

Privacy policy URL: https://vendora.lexmakesit.com/privacy
