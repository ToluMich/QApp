# MicMe Conversation Summary

## Project overview

MicMe is a live Q&A web app built with React (JavaScript), Vite, and Supabase. Anonymous visitors submit questions; administrators and moderators view and answer them in real time. Viewers can only read questions. The frontend is deployed separately from the Supabase backend.

## Product and design decisions

- The app was named **MicMe**, with a custom logo and favicon.
- The UI evolved through several color directions and settled on a bright red palette with gradients, animated elements, and a 3D-inspired visual style.
- The landing page uses an animated logo while loading and no longer displays the “Ask a question” navigation link.
- Moderator/admin entry uses the shared `/portal` route. The role is determined by the access code, not a `?portal=` value.
- The public question form preserves its draft on submission failure and clears it only after successful submission. Submission feedback uses a custom dialog.
- Staff tools include a QR code generator. QR content is processed locally and is not saved to Supabase.

## Roles and admin features

- Admins can create moderator and viewer accounts, change a user's role, activate/deactivate accounts, regenerate access codes, and delete accounts.
- Moderator and viewer users sign in at `/portal` with their access code.
- Viewers have read-only access. The backend enforces authorization in addition to the frontend hiding actions.
- Role changes, access-code resets, and deactivation invalidate existing portal sessions.
- Admins can delete all or selected questions, export questions, and reopen answered questions.
- Activity logs are limited to the ten most recent entries and are displayed in a dedicated **Activity logs** tab, separate from the **Users** tab.
- Admin user action buttons now use distinct colors: blue for new access codes, amber for deactivation, and emerald green for answering questions.

## Backend and deployment

- Supabase provides Postgres, Auth, Realtime updates, and the `qroom-api` Edge Function.
- Supabase migrations and the Edge Function are deployed separately from the frontend.
- Vercel has a rewrite so `/portal` resolves to the single-page app.
- The user has previously applied the initial role/action migration and deployed the Edge Function. Later database fixes were also applied to the linked production Supabase project.
- Production fixes included:
  - Casting `varchar` name columns to `text` in RPC results.
  - Removing an ambiguous `ON CONFLICT (user_id)` in the shared login RPC.
  - Qualifying role update query columns to avoid PL/pgSQL output-variable ambiguity.

## Troubleshooting recorded

- Generic errors during account creation, role changes, and access-code resets were traced to PostgreSQL RPC return-type mismatches; a forward migration fixed them.
- Moderator/viewer sign-ins failed because the login RPC's `ON CONFLICT (user_id)` was ambiguous. A migration corrected it, and the RPC was verified using a rolled-back diagnostic transaction.
- Role changes failed because unqualified query columns conflicted with RPC output column names. A forward migration qualified those columns and was applied.
- The fixes above were checked against the linked production migration history. No Edge Function redeploy was needed for the database-only corrections.

## Responsiveness and recent UI work

- Responsive CSS was improved for phone, tablet, desktop, and short landscape layouts, including the landing form, dashboards, admin user controls, dialogs, and QR Studio.
- Browser checks covered widths from 320px to 1440px and found no overflow in tested layouts.
- The production build passed after UI changes. Lint reports an existing React warning in `App.jsx` relating to setting state inside an effect.
- Recent styling made access-code and deactivate buttons visually distinct and changed Answer buttons to an emerald green gradient.

## Load and capacity discussion

- Whether the app can support 500 concurrent users has not been established by a load test.
- 500 anonymous question submitters are not the same load profile as 500 staff dashboard users; staff use Supabase Realtime subscriptions.
- Supabase's anonymous sign-in rate limits and Realtime connection/message limits can affect capacity. The app creates an anonymous Auth session for visitors before direct question inserts.
- A Postman Performance test was discussed as an option if available; otherwise a concurrency-oriented tool such as k6 was recommended. Testing should use a staging project, the public anon key (never the service-role key), and a gradual ramp-up.

## Current state and deployment reminder

Some recent UI improvements were implemented locally, including responsive refinements, the admin activity tab, and button styling. Building locally does not deploy the frontend; deploy the current frontend to its hosting provider for those changes to become public. Supabase changes already applied to the linked production project do not need to be reapplied.
