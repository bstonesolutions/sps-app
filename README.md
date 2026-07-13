# Stone Property Solutions — Field App (Supabase backend)

Your app, wired to your Supabase database with real email/password logins.

## Before you deploy (one-time, in Supabase)
1. Run `supabase-setup.sql` and `sps-messages-setup.sql`. These setup files fail closed.
2. Authentication → Providers → Email: make sure it is ON. Keep email confirmation enabled and
   disable open self-signup unless you intentionally support it; staff access is matched by email.
3. Authentication → Users → Add user: create YOUR account (your email + password and auto-confirm
   it), then seed `sps_team` through SQL Editor/service-role with that email as Owner.
4. Run the complete `SECURITY-RLS-MIGRATION.sql`, which installs the verified staff/owner policies.
   See `SECURITY-RLS-PLAN.md` for the rollout and verification checklist.
5. Later, add each employee the same way (Add user), then in the app open
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

### Existing production security/concurrency rollout

Do not rerun the fresh-install setup files against the live project. Use this order so installed
version 1.1 clients keep working while the version-aware release rolls out:

1. Run `APP-STATE-CONCURRENCY-MIGRATION.sql`. This additive phase installs row versions and CAS
   functions without changing existing table grants or RLS policies.
2. Deploy and verify the version-aware web/native client and the scoped portal API bridge.
3. Run `SECURITY-RLS-MIGRATION.sql` to replace the broad legacy policies. Reopen active sessions and
   test owner, staff, client, anonymous tracking, lead intake, backups, and QuickBooks status.
4. Run `APP-STATE-CONCURRENCY-ENFORCE.sql` only after every legacy browser, native build, and API
   writer is retired. It intentionally makes version 1.1 direct writes fail.

### Private customer-media rollout

1. Deploy the current web/API build first, and update any installed native build. The new clients
   understand durable `sps-storage://` references and signed URLs; older bundles only understand
   public URLs.
2. In Supabase SQL Editor, run `MEDIA-STORAGE-SECURITY-MIGRATION.sql`. It makes `client-media`
   private and installs staff/owner-only Storage policies. The script stops if an older broad
   Storage policy would still expose the bucket.
3. As the owner, open the media migration control in Customize and run **Move legacy media**. It
   moves existing inline client photos, videos, and documents only after each upload verifies and
   cancels the relink if client data changed concurrently.

Do not make the bucket private before step 1 or older web/native clients will temporarily lose
media display. Portal clients receive only short-lived links for media already in their own
allowlisted portal data.

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
- Database authorization is installed by `SECURITY-RLS-MIGRATION.sql`: verified
  staff can use shared app state, only owners can change `sps_team`, and portal
  clients must use scoped server endpoints. Do not add `USING (true)` policies for
  `authenticated`; staff and client accounts share that Supabase role.
