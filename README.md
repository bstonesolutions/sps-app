# Stone Property Solutions — Field App (Supabase backend)

Your app, wired to your Supabase database with real email/password logins.

## Before you deploy (one-time, in Supabase)
1. You already ran `supabase-setup.sql` (creates the `app_state` table). Good.
2. Authentication → Providers → Email: make sure it's ON, and turn OFF
   "Confirm email" so logins work instantly.
3. Authentication → Users → Add user: create YOUR account (your email + password,
   check "Auto Confirm User"). This first login automatically becomes the Owner.
4. Later, add each employee the same way (Add user), then in the app open
   Customize → Team & Logins, tap the member, and put THE SAME email in
   "Login Email" plus the role you want them to have.

## Deploy it (get a real link)

### Easiest: Vercel (recommended on a computer)
1. Put this folder on GitHub:
   - Make a new repo at github.com (the "+" → New repository).
   - Upload all these files (keep the folder structure: `src/` stays a folder).
   - Do NOT upload the `node_modules` folder if present.
2. Go to vercel.com → Add New → Project → import that GitHub repo.
3. Framework preset: Vite. Leave build command (`npm run build`) and output (`dist`) as detected.
4. Click Deploy. In ~1 minute you get a live link (yourname.vercel.app).
5. Open the link, sign in with the account you made in step 3 above.

Every time you push a change to GitHub, Vercel rebuilds automatically.

### Run it on your own computer first (optional)
```
npm install
npm run dev
```
Then open the local link it prints.

## Notes
- The anon key in src/supabaseClient.js is the PUBLIC key — safe to commit.
- Logins are now real (Supabase). The old in-app PIN field is ignored.
- Data lives in your database and syncs across every device.
- Current security: any signed-in user can read the data; the app's role
  settings control what each person SEES. Locking data at the database level
  per-role is the next hardening step.
