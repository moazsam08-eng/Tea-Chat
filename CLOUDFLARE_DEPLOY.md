# Deploy Tea Chat to Cloudflare Workers

Tea Chat is deployed as one Worker: Vite serves the React app as static assets, while the existing Express API handles requests under `/api/*`.

## Cloudflare Workers Builds settings

Keep the repository root directory as `./` so pnpm can resolve the workspace.

- Build command: `pnpm --filter @workspace/tea-chat build`
- Deploy command: `cd artifacts/tea-chat && npx wrangler deploy --config wrangler.jsonc`
- For now, turn off Preview builds. A separate preview Worker and its secrets should be configured before enabling preview deployments.

The Wrangler configuration is in `artifacts/tea-chat/wrangler.jsonc`; its static asset directory matches the Vite output at `artifacts/tea-chat/dist/public`.

## Environment variables

Set these three public values in **Workers Builds build environment variables** so Vite can embed them into the frontend:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` (the Supabase publishable/anon key)
- `VITE_STREAM_API_KEY`

Also set those same three values as **Worker runtime variables** because the Express API reads them through `process.env`.

Create `STREAM_API_SECRET` under **Worker Settings → Variables and Secrets** as a **Secret**, not as a plain variable and not as a build variable. Never add it to Git, a VITE-prefixed variable, or the frontend build environment.

The Wrangler config sets `NODE_ENV=production` and `LOG_LEVEL=info`. Do not override `NODE_ENV` to development in production.

## After the first successful deploy

1. Open the Worker URL and verify the React app loads.
2. Open `/api/healthz`; it should return JSON with `status: "ok"`.
3. Test sign-in and a real chat session. The health endpoint does not validate Supabase or Stream credentials.
4. In Supabase Authentication URL Configuration, add the deployed Worker URL to the allowed Site URL / Redirect URLs if the app's auth flow requires it.

## Runtime note

The Worker uses Cloudflare's Node.js HTTP server adapter to host the existing Express app. Cloudflare documents this adapter and the required Node HTTP server compatibility behavior. The actual deployment build and live sign-in/chat smoke tests still need to run in the connected Cloudflare account; this repository change alone does not prove those runtime integrations.
