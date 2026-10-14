# Tea Chat

Tea Chat is a responsive, tea-inspired messaging app for real conversations, built on Supabase authentication and Stream Chat/Video.

## Run & Operate

- `pnpm --filter @workspace/tea-chat run dev` — run the Tea Chat web app
- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/tea-chat run typecheck` — typecheck the web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required environment variable names: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STREAM_API_KEY`, `STREAM_API_SECRET`
- Keep `STREAM_API_SECRET` server-only. Only the Supabase anon key and Stream public API key belong in the browser.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Web: React, Vite, Wouter, TanStack Query
- Auth: Supabase email OTP and Google OAuth
- Messaging and calls: Stream Chat and Stream Video
- API: Express 5; Stream user tokens are minted server-side after verifying a Supabase access token
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/tea-chat` — Tea Chat web app, auth screens, workspace, and theme
- `artifacts/api-server/src/routes/stream.ts` — verifies Supabase sessions and issues Stream tokens
- `lib/api-spec/openapi.yaml` — source of truth for the Stream token API contract
- `artifacts/tea-chat/src/index.css` — app theme and responsive layout

## Architecture decisions

- Supabase remains the identity provider; the API validates the access token before returning a Stream token.
- Stream owns message and call state; the browser does not use the Stream server secret.
- API client hooks and response types are generated from the OpenAPI contract.

## Product

Tea Chat provides real Stream conversations with search, threads, reactions, attachments, and audio/video calls. Email OTP and Google OAuth are the supported sign-in methods.

## User preferences

- Keep the product name “Tea Chat” and use a tea-inspired visual style throughout.
- Prioritize a smooth, approachable interface while keeping conversations easy to read.

## Gotchas

- Enable Google as a provider in Supabase and allow the app’s `/auth/callback` URL in its redirect settings.
- For email codes, configure the Supabase email template to include `{{ .Token }}` and ensure email delivery is enabled.
- Both the web app and API server need the appropriate Supabase/Stream environment variables; never expose `STREAM_API_SECRET` to the frontend.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
