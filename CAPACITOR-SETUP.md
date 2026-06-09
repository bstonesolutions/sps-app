# SPS App — Capacitor Setup (Native iOS + Android)

## What this does
Wraps your existing web app in a native container so it can be submitted
to the App Store and Google Play. Same code, real native app.

## Prerequisites (on your Mac)
- Node.js installed (already have it for Vite)
- Xcode installed from the Mac App Store (free, large download)
- Apple Developer account ($99/year) — developer.apple.com
- Your app already deployed to Vercel

## Step 1 — Install Capacitor in your project
Open Terminal, navigate to your SPS project folder, then run:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npm install @capacitor/splash-screen @capacitor/status-bar
npx cap init
```

When prompted:
- App name: Stone Property Solutions
- App ID: com.stonepropertysolutions.app
- Web directory: dist

## Step 2 — Copy the config file
Replace the generated capacitor.config.ts with the one in this folder.

## Step 3 — Build and add iOS
```bash
npm run build
npx cap add ios
npx cap sync
npx cap open ios
```

This opens Xcode. From Xcode you can run on your iPhone or submit to the App Store.

## Step 4 — Set your app icon
In Xcode, open Assets.xcassets → AppIcon and drag in your SPS icon
at the required sizes. Use icon-1024.png (2048×2048) for the source.

## Step 5 — Submit to App Store
In Xcode: Product → Archive → Distribute App → App Store Connect
Follow the prompts. Review usually takes 1–3 days.

## Custom domain (point yourapp.com to Vercel)
1. Buy a domain at Namecheap, Google Domains, or similar
2. In Vercel: your project → Settings → Domains → Add
3. Enter your domain (e.g. app.stonepropertysolutions.com)
4. Vercel shows you two DNS records to add at your registrar
5. Add them — propagates in 24–48 hours
6. Done. Your app is live at your custom domain.

## Notes
- Every time you update the app code, run: npm run build && npx cap sync
- For App Store updates, repeat Step 3 and submit a new archive
- Android follows the same pattern with: npx cap add android && npx cap open android
