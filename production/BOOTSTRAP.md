# Morph production workspace bootstrap

The public GitHub Pages site remains a read-only showcase until it is built with the two `VITE_SUPABASE_*` values below. Once a member signs in, the workbench creates a project record and copies source files plus available PSD/CMO3/MOC3 artifacts to the private `live2d-assets` bucket. The browser never receives a service-role key.

## One-time setup

1. Create a **dedicated** Supabase project for Morph. Do not reuse `memory-agent-lab`.
2. Apply [`supabase/schema/production-foundation.sql`](../supabase/schema/production-foundation.sql) through a reviewed migration. It creates private Storage, the project/job/artifact/review/audit ledger, and RLS policies.
3. In Supabase Auth, enable email OTP and add both allowed redirect URLs:
   - `https://a1m0nd-bao.github.io/live2d-automation-workbench/`
   - `https://morph-live2d-workbench.shehaoli.chatgpt.site/`
4. Invite the first administrator through Supabase Auth, let that person complete one login, then run the two bootstrap statements at the end of the schema file with their Auth user UUID.
5. Add these two GitHub repository secrets, then redeploy Pages:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
6. Add the same browser-safe values to the private Site build environment. Separately give only the persistent worker/API `MORPH_SUPABASE_URL` and `MORPH_SUPABASE_SERVICE_ROLE_KEY`; that private key must never be put in GitHub Pages, frontend files, or a `VITE_` variable.

## Retention and access model

- Original input, PSD, CMO3/MOC3 packages, and `.stretch` are permanent project assets.
- Previews and reports are marked diagnostic and receive a 30-day `delete_after` timestamp for the cleanup worker.
- Creators can read their workspace and create their own projects; only administrators can read audit logs or decide reviews. The worker writes stage transitions and final artifacts with its service role.

## Current migration boundary

This release makes the web workbench authenticate and persist browser-created project metadata and files. The existing See-Through relay already has a persistent SQLite queue and restart recovery. Its job-state mirror and the browser-only Cubism export must be moved into the private worker next; until then, a browser tab is still required while Cubism export is executing. This is intentionally shown as a boundary rather than represented as completed server automation.
