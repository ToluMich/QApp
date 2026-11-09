# MicMe

MicMe is a React/Vite frontend backed entirely by Supabase: Postgres stores questions and moderator data, Supabase Realtime streams question changes, and an Edge Function handles PIN login and privileged actions. The frontend remains plain JavaScript/JSX.

## Create and configure Supabase

1. Create a Supabase project at https://supabase.com/dashboard. Keep the project URL and publishable/anon key available.
2. In **Authentication → Sign In / Providers**, enable **Anonymous Sign-Ins**.
3. In the project root, copy `.env.example` to `.env.local` and set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Sign in to the Supabase CLI:
   ```powershell
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   ```
5. Apply the database schema and RLS policies to your new, empty Supabase project:
   ```powershell
   npx supabase db push --remote
   ```
   This creates MicMe's tables and security policies; it does not restore a backup or import data from Firebase. Start with a new Supabase project if you want a clean database.
6. Configure Edge Function secrets in **Project Settings → Edge Functions → Secrets**:
   - `ADMIN_PIN`: your chosen six-digit admin PIN. Do not keep the example PIN for a public app.
   - `PIN_INDEX_SECRET`: a private random secret (at least 32 random bytes, hex encoded).
   Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions.
7. Deploy the backend function:
   ```powershell
   npx supabase functions deploy qroom-api
   ```

For later backend updates, run `npx supabase db push --remote` to apply new migrations, then redeploy `qroom-api` when its source changes. Moderator names are unique regardless of capitalization, and admin activity logs stream live through Supabase Realtime. The admin interface supports deleting individual moderators, permanently deleting all questions, and exporting all or selected questions to an Excel-readable `.xls` workbook. Destructive actions require confirmation.

Never put the service-role key, admin PIN, or PIN index secret in the React `.env.local` or in source control. The frontend only needs the public Supabase URL and publishable/anon key.

## Run locally

```powershell
npm.cmd install
npm.cmd run dev
```

Open the localhost URL Vite prints. The frontend talks directly to Supabase. Anonymous Auth is used to establish a browser session; the Edge Function validates PINs and grants server-side application sessions. Live question updates use Supabase Realtime, protected by Postgres RLS. The new Supabase database starts empty; no old Firebase questions or moderator records are imported.

## Deploy the frontend later

Deploy the Vite app to Vercel and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as Vercel environment variables. Supabase remains the backend; there is no Apps Script or Firebase runtime dependency.
