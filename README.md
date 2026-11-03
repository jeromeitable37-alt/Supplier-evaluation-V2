# New Supplier Evaluation — Cloudflare + Supabase + Resend

**Separate starter project.** Does not modify the original Vercel/Firebase Supplier Evaluation System or the existing "Asy fam" Supabase project.

## Included

- Cloudflare Worker serving a lightweight responsive Admin UI and public evaluation form.
- Supabase Auth email/password login and server-verified `admin_users` access (no open mail relay).
- Private Supabase PostgreSQL `evaluation_requests` table with RLS enabled and no anonymous read access.
- Server-only Resend transactional email API with a **verified From domain** and configurable **Gmail Reply-To**.
- Purple evaluation email, unique signed evaluator link, 1–5 rating form, and one-submission rule.
- One-time send lock and status tracking: `pending`, `sending`, `sent`, `submitted`.
- Recipients can use **any legitimate email domain** (Gmail, `@southville.edu.ph`, `@sgen.edu.ph`, etc.) subject to each provider's filtering.

**Not included yet:** Google Drive upload/PO document attachments, old data migration, custom sender domain purchase or verification, scheduled reminders, Resend delivery webhooks, or a deployed Cloudflare account. This is a first secure email/evaluation milestone, not a completed enterprise system.

## Important Resend limitation

You **cannot** use `@gmail.com` as the verified From address in production. You **can** use Gmail as `RESEND_REPLY_TO_EMAIL`, and send to recipients on many domains. To send to arbitrary recipients, someone must verify a sender domain that they own/control by adding Resend DNS records. The Cloudflare `workers.dev` subdomain is for **website hosting**, not a Resend sending domain.

Resend's free tier currently provides 3,000 transactional emails/month and 100/day. **No service guarantees Inbox**; recipient spam policies still apply.

## 1. Create a NEW Supabase project

Select the Supabase organization where you want the new project. **Do not reuse `Asy fam`.** Create a project, open SQL Editor, run `supabase/schema.sql`.

In Authentication → Users, create a user account for yourself and confirm it. Then in SQL Editor execute:

```sql
insert into public.admin_users (user_id)
select id from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL@gmail.com')
on conflict (user_id) do nothing;
```

Use a unique password, and don't paste secrets into chat or GitHub.

## 2. Configure Resend

1. Create a free Resend account: https://resend.com
2. Add and verify **a domain you own/control**: https://resend.com/domains
3. Create a Resend API key: https://resend.com/api-keys
4. Choose a From address on that verified domain, e.g. `Supplier Evaluation <evaluation@yourdomain.com>`.
5. Choose your own Gmail address as the Reply-To. Replies will go there; the displayed **From is the verified-domain address**, not Gmail.

School domain DNS access isn't required if you use a different verified domain; the recipient domains never require verification.

## 3. Run locally

Requires Node.js 20+ and Cloudflare Wrangler.

```bash
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your own values (never commit secrets).
npm run test
npm run dev
```

Local URL (usually): http://localhost:8787/

Required environment variables:

| Variable | What it holds |
|---|---|
| `SUPABASE_URL` | Your new Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Safe Supabase publishable public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret, server-only Supabase role key |
| `EVALUATION_TOKEN_SECRET` | 32+ character random key for evaluation URLs |
| `RESEND_API_KEY` | Secret Resend API key |
| `RESEND_FROM_EMAIL` | Email under a verified domain (may include display name) |
| `RESEND_REPLY_TO_EMAIL` | Gmail address to receive replies |
| `APP_BASE_URL` | Absolute website URL, e.g. https://your-worker.your-subdomain.workers.dev |

**Never use a `NEXT_PUBLIC_` prefix for secret values.** `/api/config` intentionally exposes only your Supabase URL + publishable key.

## 4. Deploy on Cloudflare Workers

Connect/login to your own Cloudflare account. From the project folder:

```bash
npx wrangler login
npm run deploy
```

Then set every required secret. The command will prompt you to paste the value without storing it in code:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put EVALUATION_TOKEN_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL
npx wrangler secret put RESEND_REPLY_TO_EMAIL
npx wrangler secret put APP_BASE_URL
```

Set `APP_BASE_URL` to the final Cloudflare Worker HTTPS URL after the first deploy. Changing Worker secrets publishes a new version. Open `/api/health` to check that database/email variables are present (this does **not** verify they are valid).

## 5. Test

1. Open the Cloudflare Worker URL and sign in with your new Supabase Auth admin account.
2. Create a **test** evaluation request to an email address you control.
3. Click **Send evaluation email**. The Worker calls Resend using the verified sender.
4. Check the inbox/spam folder and the Resend dashboard delivery events.
5. Open the signed evaluation link, rate 1–5, submit once, then refresh the admin dashboard to see `submitted`.

For real school use, connect the PO documents to a **private** storage access flow and add the school's evaluation criteria/permissions before rollout.

## Security notes

- Do not enter a Resend or Supabase secret into the browser or version control.
- Server authenticates admin access on every admin API request, and only the server uses the service-role key.
- RLS blocks all direct browser table reads. The HMAC secret signs unique evaluation links; changing it invalidates all old links.
- If an email send is ambiguous (e.g., Resend accepts but database update fails), the request remains `sending` to prevent duplicates. Check the Resend dashboard before an administrator manually resets it in SQL.
- This starter does **not** authorize users to impersonate a school domain or sender without its approval. Use a domain you control.
- Email acceptance by Resend is not proof of delivery/inbox placement. No guarantee against spam filtering.

## Files

- `src/worker.js` — authenticated APIs, signed tokens, Resend integration.
- `public/` — responsive admin and evaluator web pages.
- `supabase/schema.sql` — tables + locked-down RLS.
- `wrangler.jsonc` — Cloudflare Worker configuration.
- `.dev.vars.example` — secret names and safe placeholders.
- `tests/worker.test.mjs` — smoke tests.
