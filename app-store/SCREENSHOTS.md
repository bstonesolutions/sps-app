# SPS Way — Screenshots & App Preview Plan

Apple shows the **first 2–3 screenshots** in search results, so lead with client value.
**Required:** one set for **6.9"/6.7" iPhone** (1320 × 2868 or 1290 × 2796 px). Up to 10 per size.

---

## The look (recommended)

Branded marketing frames beat raw captures. Each screenshot =
- Crimson `#B81D24` background (your brand)
- A short **white headline** at the top (≤ 6 words)
- The **real app screen** in a phone frame below

I can build this template/overlay once you hand me the real screen captures — you just
capture the screens, I'll frame + caption them.

---

## The 6-screenshot story (in this order)

| # | Headline (white, top) | Screen to capture |
|---|---|---|
| 1 | **Your service. All in one app.** | Client portal **Home / My Property** |
| 2 | **Know exactly when we arrive.** | **Live tracking** card (map + ETA) |
| 3 | **Every visit, fully documented.** | A completed **service report** (water tests + photos) |
| 4 | **View & pay invoices securely.** | **Invoices** screen |
| 5 | **Request service in seconds.** | **Messages / Request Service** |
| 6 | **Built for the field crew, too.** | Staff **schedule/route** or a service report |

Sub-captions (optional, smaller line under each headline) live in §2–3 of `SUBMISSION.md`.

---

## How to capture (tomorrow)

- **Simulator (cleanest):** Xcode → run on **iPhone 16 Pro Max** (6.9", 1320 × 2868) → `⌘S`
  saves each screen at the exact required size.
- **Real device:** screenshot on the phone, AirDrop to the Mac (works if it's a Pro Max-class
  screen; otherwise simulator is safer for exact pixel dimensions).
- **Quick proxy:** I can also drive the web preview at phone width to grab rough versions so we
  can lay out the frames before the final simulator pass.

Tip: turn **Test Mode** off and sign in with a clean demo account so the screens look real
(no "TEST" pill, sensible numbers).

---

## iPad — a decision to make

The app has iPad layouts. If **iPad** is a supported device in the Xcode target, Apple
**requires a 13"/12.9" iPad screenshot set too**. Two options:
- **Keep iPad** → capture a second set on the iPad Pro simulator, or
- **iPhone-only** → set the target to iPhone in Xcode and skip the iPad set entirely.

Tell me which and I'll note it.

---

## App Preview video (optional — up to 3, 15–30s each)

Not required for launch. A nice 20-second screen-recording could run:
open app → live tracking → service report → pay an invoice. We can add this after 1.0 is live.
