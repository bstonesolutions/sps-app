# Owner "invoice paid" phone push — setup checklist (Build 15, Item 6)

The **in-app banner** (owner sees a payment-received banner while using the app) already works
with no setup. This file is the **out-of-app push** — the owner's phone buzzes even when the app
is closed — which is real infrastructure. Do these once.

## 1. Supabase tables
```sql
-- iOS device tokens to push to (the client app registers these — see step 5).
create table device_tokens (
  token      text primary key,
  role       text,                      -- 'owner' for the owner's phone(s)
  updated_at timestamptz default now()
);
-- A valid QuickBooks access token per realm, so the webhook can fetch payment details.
-- The app already refreshes QB tokens (api/quickbooks/refresh.js); have it upsert the
-- current access_token here on refresh, keyed by realm_id.
create table qb_connections (
  realm_id     text primary key,
  access_token text,
  updated_at   timestamptz default now()
);
```

## 2. APNs Auth Key (Apple Developer → Certificates, IDs & Profiles → Keys)
- Create a key with **Apple Push Notifications service (APNs)** enabled → download the `.p8`.
- Note the **Key ID** and your **Team ID**.
- In Xcode, add the **Push Notifications** capability to the App target (the .entitlements gets `aps-environment`).

## 3. Edge Function secrets
```bash
supabase secrets set \
  QB_WEBHOOK_VERIFIER_TOKEN="…from Intuit webhook config…" \
  QB_API_BASE="https://quickbooks.api.intuit.com" \
  APNS_KEY_ID="ABCD1234" APNS_TEAM_ID="TEAMID1234" \
  APNS_BUNDLE_ID="com.stonepropertysolutions.app" \
  APNS_HOST="https://api.push.apple.com" \
  APNS_PRIVATE_KEY="$(cat AuthKey_ABCD1234.p8)"
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided to the function automatically.
```

## 4. Deploy + register the QB webhook
```bash
supabase functions deploy qb-payment-webhook --no-verify-jwt
```
- Copy the function URL, then in **developer.intuit.com → your app → Webhooks**, add it as the
  endpoint and subscribe to **Payment** events. Intuit shows the **Verifier Token** there → use it
  for `QB_WEBHOOK_VERIFIER_TOKEN` above. (`--no-verify-jwt` because QB signs the request itself;
  the function verifies the `intuit-signature` header.)

## 5. Client: register the device token (one-time native add)
- `npm i @capacitor/push-notifications` then `npx cap sync ios`.
- On owner sign-in, request permission, register, and upsert the token:
```js
import { PushNotifications } from "@capacitor/push-notifications";
await PushNotifications.requestPermissions();
await PushNotifications.register();
PushNotifications.addListener("registration", async ({ value }) => {
  await supabase.from("device_tokens").upsert({ token: value, role: "owner", updated_at: new Date().toISOString() });
});
```

## How it behaves
- QuickBooks fires on a Payment → the function verifies the signature, fetches the payment
  (amount + customer + linked invoice) from QB, and pushes **"Payment received — $X · {who} paid
  invoice {n}"** to every `role='owner'` device token. If the QB token is missing it still sends a
  generic "open the app for details" alert rather than nothing.
- The same pattern extends to other events (new message, upgrade request) by adding more
  triggers; honor the per-user channel settings before sending.
