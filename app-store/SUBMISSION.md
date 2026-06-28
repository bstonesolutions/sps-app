# SPS Way — App Store Submission Pack

Everything you need to take **SPS Way** from "build uploaded" to "live on the App Store."
Fill in the few `[BRACKETED]` blanks with your real info, then paste each section into
**App Store Connect** ([appstoreconnect.apple.com](https://appstoreconnect.apple.com)).

> Blanks only you can fill: `Stone Property Solutions LLC` (e.g. *Stone Property Solutions LLC*),
> `[SUPPORT EMAIL]`, `[STATE]`, `[APP DOMAIN]` (your live web address — currently
> `sps-app-azure.vercel.app`), `[SUPPORT/MARKETING URL]`.

---

## 1. App Information

| Field | What to enter |
|---|---|
| **Name** | `SPS Way` |
| **Subtitle** (≤30 chars) | `Pond & pool service, simplified` |
| **Primary Category** | Business *(secondary: Productivity)* |
| **Privacy Policy URL** | `https://[APP DOMAIN]/privacy.html` *(after you host the policy — see §6)* |
| **Support URL** *(required)* | `[SUPPORT/MARKETING URL]` *(a page or even a mailto-style page is fine)* |
| **Marketing URL** *(optional)* | your website, if you have one |

---

## 2. Promotional Text (≤170 chars — editable anytime, no review needed)

> Your pond and pool service, all in one place — see your visit history and photos, view and pay
> invoices, and request service. For our crew: routes, reports, and clock-in built in.

## 3. Description (paste into the Description field)

```
SPS Way is the official app of Stone Property Solutions LLC — your direct line to your pond and pool service.

FOR OUR CLIENTS
• See your full service history, water test results, and photos from every visit
• View and pay your invoices securely — powered by QuickBooks
• Get notified when your technician is on the way, arrives, and finishes
• Request service or ask a question in seconds
• Securely sign in to your account to see everything in one place

FOR OUR TEAM (staff sign-in)
• Your day's route, optimized, with one-tap directions
• Complete each stop: water tests, treatments, parts, photos, and a full service report
• Clock in and out, track inventory, and send branded invoices and reports
• Live location sharing so clients know exactly when you'll arrive

Built for the field, designed to keep you informed. Welcome to the SPS Way.
```

## 4. Keywords (≤100 characters total, comma-separated, no spaces after commas)

```
pond service,pool service,water care,field service,client portal,invoice,route,maintenance,scheduling
```

## 5. What's New in This Version (release notes for 1.0)

```
Welcome to SPS Way! View your service history and photos, pay invoices, get real-time arrival updates, and request service — all in one app.
```

---

## 6. Privacy Policy — hosting it (REQUIRED before you can submit)

A ready-to-host page is in `app-store/privacy-policy.html`. Two ways to get a live URL:

- **Easiest (recommended):** I can drop it into your app at `public/privacy.html` and push — it'll be
  live at `https://[APP DOMAIN]/privacy.html` after the auto-deploy. (Just say the word.)
- **Or** host it on your marketing website and use that URL.

Before it goes live, fill in the blanks inside the file: `Stone Property Solutions LLC`, `[SUPPORT EMAIL]`,
`[STATE]`, and the effective date.

---

## 7. App Privacy (the data questionnaire — REQUIRED before submit)

App Store Connect → your app → **App Privacy**. Answer "**Yes, we collect data**," then mark these
data types. **None of it is used for tracking**, and **everything is "Linked to the user"** and used
only for **App Functionality** (no third-party advertising/analytics SDKs in the app).

| Data type | Collected? | Linked to user? | Tracking? | Purpose |
|---|---|---|---|---|
| **Contact Info** — Name, Email, Phone, Physical Address | ✅ Yes | Yes | No | App Functionality |
| **Location** — Precise Location | ✅ Yes | Yes | No | App Functionality *(crew location while on a job; client ETA/route)* |
| **User Content** — Photos, Other (service notes/reports) | ✅ Yes | Yes | No | App Functionality |
| **Identifiers** — User ID | ✅ Yes | Yes | No | App Functionality |
| **Financial Info** — Other Financial Info (invoice amounts / balances) | ✅ Yes | Yes | No | App Functionality |
| **Purchases** — Purchase History (invoice/payment status) | ✅ Yes | Yes | No | App Functionality |

**Mark as NOT collected:** Health & Fitness, Sensitive Info, Contacts (device address book), Browsing
History, Search History, Diagnostics/Crash data, Usage analytics, **Payment Info (card numbers)** — card
payments are handled entirely by **QuickBooks**; your app never sees or stores card data.

> Because nothing is used for tracking, you do **not** need an App Tracking Transparency prompt.

---

## 8. App Review Information (THE #1 thing apps like yours get rejected for)

Your app requires a login, so Apple's reviewer is stuck at the sign-in screen unless you give them an
account. App Store Connect → your version → **App Review Information**:

Everyone — staff and clients — signs in on the same screen with an **email + password**, so you can
give the reviewer **two** accounts: one staff and one client. Enter the staff one in the credential
fields, and put the client one in the Notes.

- **Sign-In required:** ✅ Yes
- **User name:** `[staff demo login — e.g. appreview-staff@[APP DOMAIN]]`
- **Password:** `[its password]`
- **Notes (paste this):**

```
This is the field-service app for Stone Property Solutions LLC. Everyone signs in on the same screen with an
email and password.

STAFF / OWNER (full app): the username and password above open the complete staff experience —
schedule, clients, invoices, reports, and inventory.

CLIENT PORTAL (customer view): to review the customer side, sign in instead with:
   Email: [client demo login]
   Password: [its password]
That opens the customer portal — service history, photos, invoices, and "request service."

Accounts are provisioned by the business; there is no public sign-up. Location is used only while the
app is open, to share a technician's live position with a customer during a visit.
```

> **Action for you:** in the app, create one demo **staff** login and one demo **client** login, set a
> password on each, and confirm both can sign in before you submit.

---

## 9. Age Rating

Run Apple's questionnaire — for SPS Way every answer is **None**, giving you a **4+** rating. (No
objectionable content, no user-generated public content, no gambling, etc.)

---

## 10. Screenshots (REQUIRED — the one thing I can't generate for you)

You need at least one set, for **6.7" iPhone** (1290 × 2796 px). Easiest path:
1. Run the app on the iPhone 15 Pro Max simulator (or your device).
2. Capture 3–6 screens: **Home**, **Schedule**, a **completed service report**, **Invoices**, and the
   **client portal**.
3. Drag them into the version's Screenshots area.

If you also support iPad, add a 12.9" iPad set (or remove iPad support to skip it).

---

## 11. Pricing & Availability

- **Price:** Free *(recommended — it's your business's app for your clients/crew)*
- **Availability:** United States *(or wherever you operate)*

---

## ✅ Final pre-submit checklist

- [ ] Build **24** shows "Ready to Submit" (finished processing) and is attached to the version
- [ ] Privacy Policy hosted + URL entered (§6)
- [ ] App Privacy questionnaire completed (§7)
- [ ] Demo staff account created + entered in App Review Information (§8)
- [ ] Description, subtitle, keywords, promo text filled in (§1–5)
- [ ] Screenshots uploaded (§10)
- [ ] Age rating done (§9)
- [ ] Pricing set (§11)
- [ ] **Submit for Review**, choose **manual** or **automatic** release

After submit: review is usually **24–48h**. If rejected, it's almost always the demo account or a
privacy detail — fix it and resubmit (metadata fixes don't need a new build).
