# Morph production workspace bootstrap

The public GitHub Pages site remains a read-only showcase until it is built with the public `VITE_MORPH_API_URL` below. Once an invited member signs in, the workbench creates a project record and copies source files plus available PSD/CMO3/MOC3 artifacts to a private R2 bucket. R2 and D1 credentials never enter the browser.

## One-time setup

1. Create a Cloudflare account owned by you or your company, add an API hostname under a domain you control, then create one D1 database and one private R2 bucket. No shehaoli account is involved.
2. Apply `cloudflare-backend/migrations/0001_initial.sql` with Wrangler, then deploy `cloudflare-backend`.
3. Create a Zero Trust Access application in the same Cloudflare account for the API domain. Enable Cloudflare One-time PIN, and allow only explicit company emails or approved email domains. It sends the email code itself, so no separate mail provider is required.
4. Set Worker variables `MORPH_ALLOWED_ORIGINS`, `MORPH_ACCESS_TEAM_DOMAIN`, `MORPH_ACCESS_AUD`, and `MORPH_ADMIN_EMAILS`; protect only `/v1/access/exchange` with the Access application. The allowed admin email provisions itself on its first successful OTP login.
5. Add GitHub secret `VITE_MORPH_API_URL`, then redeploy Pages. Add the same value to the private Site runtime variable `MORPH_API_URL`.

## Retention and access model

- Original input, PSD, CMO3/MOC3 packages, and `.stretch` are permanent project assets.
- Previews and reports are marked diagnostic and receive a 30-day `delete_after` timestamp for the cleanup worker.
- Creators can read and create only their own projects; administrators can see every project, read audit logs, and decide reviews. Access invitations are managed as explicit email rules in the Cloudflare Zero Trust dashboard for this first release.

## Current migration boundary

The existing See-Through relay already has a persistent SQLite queue and restart recovery. Its job-state mirror and the browser-only Cubism export must be moved into the private worker next; until then, a browser tab is still required while Cubism export is executing. This is intentionally shown as a boundary rather than represented as completed server automation.
