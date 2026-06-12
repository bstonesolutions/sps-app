# HANDOFF — SPS App

Snapshot for the next session. For permanent rules see **CLAUDE.md** (never modify
`supabaseClient.js`/storage layer; no real-data fallback defaults; show changes
before commit; run `npm run build` after editing `App.jsx`).

## Current state

- **Latest commit:** `0bdeb32` — "Move reminder settings into Customize > Business 'Reminders & Messaging'" (Fri Jun 12 2026)
- **Branch:** `main`, in sync with `origin/main`. Working tree clean (only `package.json`/`package-lock.json` show as modified — pre-existing, untouched by recent work).
- **Build:** `npm run build` (Vite) passes. Deploy: **Vercel**, auto-deploys from GitHub `main`. **No service worker**; `dist/` is not committed (Vercel builds fresh). iOS users may need to fully close/reopen the home-screen PWA to pick up a new bundle.

## Architecture quick map

- **`App.jsx`** — the entire app (one large file): staff app shell + all screens, the client portal (`SPSClientPortal`), settings (`AppSettings`), invoices, etc.
- **`main.jsx`** — login screen (password + magic link), first-login `SetPassword`, forgot-password.
- **`config.js`** — `PROD_URL = https://sps-app-azure.vercel.app` (used for every emailed/shared link).
- **`index.html`** — static shell; body/html/#root background = `#B81D24` (splash color); global keyframes (`spin`, `syncPulse`, `spsModalIn`).
- **`supabaseClient.js`** — DO NOT MODIFY. Exports `store` (app_state table) + `supabase`. App state persists via the `useStoredState` hook (slices: `sps_clients`, `sps_branding`, `sps_invoicing`, `sps_email`, `sps_invoices`, `sps_service_tiers`, `sps_schedule_cfg`, `sps_team`, `sps_nav_dock`, `sps_estimates`, etc.).
- **`api/quickbooks/*.js`** — serverless: `create-invoice`, `update-invoice`, `sync`, `refresh`, `auth`, `callback`, `delete-invoice`, `qb-helpers` (item find-or-create + tax-code helpers).
- **`api/send-auth-email.js`** — Resend delivery for staff invites / client magic links (Supabase admin `generate_link` → Resend).
- **`api/send-invoice.js`** — Resend delivery of a branded invoice email.

### Env vars (set in Vercel)
- `RESEND_API_KEY` + `SUPABASE_SERVICE_ROLE_KEY` — required for branded invite/magic-link/invoice emails (otherwise invites fall back to Supabase's built-in email). Optional: `RESEND_FROM`, `SUPABASE_URL`.
- `QB_CLIENT_ID` + `QB_CLIENT_SECRET` — QuickBooks OAuth/refresh.

### Supabase dashboard (must be set, else links point at localhost)
- Authentication → URL Configuration → **Site URL** = `https://sps-app-azure.vercel.app`, and add it (+`/**`) to **Redirect URLs**.

## What's been built (this session, in order)

| Commit | Feature |
|---|---|
| `ff52ea8` | Added `CLAUDE.md` standing rules |
| `bc7686b` | Invoice header formatting, QB update sync, sync-button animation |
| `1d22b4e` | Fix QB rejecting invoice edits; surface real QB error reason |
| `0544aeb` | Invoice/QB fixes, page+splash persistence, custom email templates (defaults) |
| `c94567f` | Point invite/magic links at `PROD_URL`; deliver branded emails via Resend |
| `a967b32` | Surface Resend failures + `GET /api/send-auth-email` health check |
| `8052aaf` | Invite-email editor as its own visible panel; tint header icons |
| `9cabd55` | **Role-based staff permissions** — per-tab hidden/view/edit + presets |
| `8b7e1a4` | Staff **set password on first login** + forgot-password |
| `a8bae5d` | **"Send to Client"** on invoices (Resend email + in-app portal notification) |
| `cb09d0a` | Center + make the staff Clients list responsive |
| `1eb1eb7` | **Bottom nav: 4 customizable slots + fixed Menu** (slide-up sheet) |
| `cea7fc5` | **Customize auto-save** (debounced) + per-section Undo + Saved indicator |
| `2203ec4` | **Service tiers**: editable "None" tier + multi-select "Upgrades To" |
| `e3be4ce` | iOS PWA: lock header & bottom nav (contained scroll) |
| `64f7798` | Header cleanup: removed top Menu, Sync to far right |
| `be00444` | **QuickBooks payment-method** setting (Card/ACH, default on) |
| `6545188` | Invoice fixes: Print, stable centered modals, solid backdrop |
| `5df3f7b` | Invoice **Print/Export = real PDF** + native share sheet + download fallback |
| `df76c05` | **Smart reopen**: hard-close resync / long-idle splash / quick-return in place |
| `7228f11` | Eliminate off-color flash before splash (index.html = `#B81D24`) |
| `4116cee` | **Late fee system** — settings, auto-apply on load, QB read/write, display |
| `e41503c` | Strengthen iOS PWA lock (`position:fixed` body); desktop Print download; invoice-detail layout cleanup |
| `0bdeb32` | Move reminder settings → Customize > Business "Reminders & Messaging" |

## Open / incomplete items (verify or follow up)

### Needs on-device verification (couldn't be tested from the dev environment)
1. **iOS PWA header/nav lock** (`e3be4ce` → strengthened in `e41503c`). Now uses `position: fixed` on `<body>` (both staff shell + portal). **If it STILL drifts in the installed standalone app**, the next escalation is a `visualViewport`-based JS lock. Fully close/reopen the app to load the new bundle before testing.
2. **Print/Export PDF** (`5df3f7b`, `e41503c`). Mobile → native share sheet; desktop (no touch / `navigator.maxTouchPoints === 0`) → direct download. Verify on iPhone, Android, and desktop Mac.
3. **Smart reopen** (`df76c05`). Kill-vs-resume detection via `sessionStorage`. Verify: swipe-away→reopen = Home+resync; 30+min background = Home+splash; <30min = stay put. Threshold = `IDLE_MS = 30*60*1000`.
4. **Late fee system** (`4116cee`). Verify on a genuinely overdue (Sent, >grace-days past due, not Paid/Draft) invoice that the fee line appears in staff detail, PDF, and client portal, and totals update. Configure under Customize → Business → **Late Fees** (all blank/off by default).

### Known design notes / possible follow-ups
- **Late fee "Apply once" toggle** is a safety affirmation — the fee never compounds on load (guarded by `lateFeeAppliedAt` + line scan). OFF state has no special "re-apply each period" behavior. Invoices with **no editable line items** (e.g. QB stored-total-only) are skipped. QB write needs/creates a **"Late Fee"** service item (requires an Income account in QB).
- **Service tiers** (`2203ec4`): the client portal now **respects each tier's configured `upgradeTo` list** (previously it showed all higher tiers regardless) — review each tier's toggles. The custom "None" tier name shows in the tier manager; it is **not** propagated to every portal display (untiered clients store `plan: ""`).
- **Resend / login emails**: the **login-screen self-service magic link** (`main.jsx`) still uses Supabase's built-in email (not Resend) — only the staff-invite and staff-sent client portal-link flows route through Resend. Could be wired to Resend if desired.
- **QB payment methods** (`be00444`): Card/ACH toggles only surface if the method is also enabled in the user's **QuickBooks Payments account**.
- **Customize auto-save** (`cea7fc5`): applies to form-style sections. Complex sub-managers — **Service Catalog editor, Service Tiers, Bulk Pricing** — kept their own existing save flows.
- **Reminders move** (`0bdeb32`): only the **settings** moved to Customize → Business. The standalone **Reminders page still exists** for the operational send-queue. Offered to fold the whole page in + remove the nav entry — not yet done.
- **Splash flash fix** (`7228f11`): index.html is a static `#B81D24` (default crimson). A user with a **customized** splash color still gets one brief default-crimson frame before JS applies their color.
- **Permissions** (`9cabd55`): Estimates shares the `canInvoice` flag. Full view-only is enforced on Clients/Schedule/Invoices/Inventory/Customize; lighter tabs (Home/Reports/Budget/Messages/Reminders) are visibility-only.

## How to work here
- Edit `App.jsx` → `npm run build` to confirm it compiles → show the diff → wait for review → commit + push (Vercel deploys).
- Commit message footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- QB API files (`api/quickbooks/*.js`, `api/send-*.js`) are ESM serverless functions — `node --check <file>` to syntax-check.
