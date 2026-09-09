# Morph production workspace bootstrap

The production workspace uses a Supabase project owned by the operator: email OTP identifies invited members, Postgres holds the project ledger, and the private `morph-assets` Storage bucket holds source images, PSDs, CMO3/MOC3 bundles, previews, and reports. The public GitHub Pages showcase contains only the Supabase URL and publishable key; database access is constrained by Row Level Security (RLS).

## One-time setup

1. In Supabase SQL Editor, run `supabase/migrations/20260909085841_production_foundation.sql`. It creates the private Storage bucket, tables, audit trail, and ownership policies.
2. In Authentication > Sign In / Providers > Email, keep Email enabled and disable new user sign-ups. The workbench uses Supabase's default one-time email link, so custom SMTP and editable email templates are not required.
3. Invite the first operator from Authentication > Users > Invite user. After accepting the invitation, set their profile role to `admin` in SQL Editor: `update public.profiles set role = 'admin' where email = '<operator-email>';`.
4. Add the browser-safe values to GitHub Actions secrets: `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, then redeploy GitHub Pages. Add the same values to the private preview runtime as `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.

## Access and retention model

- A creator can create, read, and upload only to their own projects.
- An administrator can read every project, manage profile roles, review deliveries, and read the audit log.
- Original input, PSD, CMO3/MOC3 packages, and `.stretch` are permanent project assets. Previews and reports are marked diagnostic with a 30-day deletion timestamp.
- The `service_role` key and database password never enter GitHub Pages, the private preview, or browser code.

## Current automation boundary

The existing See-Through relay already has a persistent SQLite queue and restart recovery. The browser currently mirrors task metadata and available artifacts to Supabase after a user signs in. Moving relay job-state mirroring into the persistent worker and moving browser-only Cubism export to a compatible worker remain the next server-automation slice; a browser tab is still needed during Cubism export today.
