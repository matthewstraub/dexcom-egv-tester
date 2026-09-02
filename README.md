# Dexcom EGV Tester

A developer tool for exercising the [Dexcom API](https://developer.dexcom.com/docs). Authenticate via OAuth2 against the Sandbox or Production environment, pull Estimated Glucose Values, inspect the raw responses, and correlate glucose against Apple Health metrics.

**Live:** https://dexcom-egv-tester.onrender.com

Runs in **single-user mode** — no login. One set of OAuth tokens is stored per environment, so the last person to authenticate owns the active connection.

---

## What it does

- **OAuth2 against either environment** — Sandbox (`sandbox-api.dexcom.com`, test users, no password) or Production (`api.dexcom.com`, real credentials and real patient data). The UI defaults to Production and warns you about it.
- **EGV queries** with a date-range picker, validated against Dexcom's 30-day-per-request cap.
- **Glucose timeline chart** with target-range shading, low/high/urgent-low thresholds, trend arrows and rate-of-change on hover, and an average-glucose badge.
- **UTC / local timezone toggle** applied consistently across inputs, axis labels, tooltips and exports. Dates are always converted to UTC before hitting the API.
- **Raw response viewer** with syntax highlighting, so you can see exactly what Dexcom returned.
- **Exports** — CSV, raw JSON, and a PNG of the chart with a metadata header.
- **Apple Health correlations** — upload an Apple Health export ZIP and overlay steps, heart rate, HRV, active energy, exercise time, distance or SpO2 against glucose, with Pearson coefficients per metric. Parsing happens entirely in your browser.

---

## Quickstart

Requires Node 20+ and pnpm.

```bash
pnpm install
```

Create a `.env` in the repo root:

```bash
DATABASE_URL="mysql://user:pass@host:4000/db?ssl={\"rejectUnauthorized\":true}"
DEXCOM_CLIENT_ID="your_client_id"
DEXCOM_CLIENT_SECRET="your_client_secret"
```

```bash
pnpm dev
```

The server prefers port 3000 and scans upward if it's taken — watch the startup line for the actual URL. Register `http://localhost:<port>/api/dexcom/callback` as a redirect URI in your Dexcom developer app before trying the OAuth flow locally.

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server with hot reload |
| `pnpm build` | Production build (client via Vite, server via esbuild) |
| `pnpm start` | Serve the production build |
| `pnpm check` | Type-check with `tsc --noEmit` |
| `pnpm test` | Run the Vitest suite |
| `pnpm db:push` | Generate and apply Drizzle migrations |

Without a `DATABASE_URL` the app still boots, but the EGV Data tab stays disabled and four credential/database-dependent tests fail. That's expected locally.

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | MySQL-compatible connection string. Keep the `?ssl={"rejectUnauthorized":true}` suffix for TiDB Cloud. |
| `DEXCOM_CLIENT_ID` | Yes | From the Dexcom developer portal |
| `DEXCOM_CLIENT_SECRET` | Yes | From the Dexcom developer portal |
| `NODE_ENV` | Yes in prod | Must be `production` for deployed builds |
| `PORT` | No | Render sets this automatically |

---

## Project layout

```
client/src/
  pages/            Home (tabs), Correlations, NotFound
  components/       EgvChart, CorrelationChart, JsonViewer, ui/ (shadcn)
  lib/              timezone, export, splitDateRange, trpc
  workers/          appleHealthWorker — browser-side ZIP + XML parsing
server/
  dexcom.ts         Dexcom service layer: tokens, refresh, API calls
  dexcomRoutes.ts   Express OAuth routes
  routers.ts        tRPC procedures (dexcom.*, appleHealth.*)
  _core/            server entry, tRPC setup, Vite middleware
shared/const.ts     Dexcom base URLs, Apple Health metric definitions
drizzle/schema.ts   Database tables
```

---

## Documentation

- **[DOCUMENTATION.md](DOCUMENTATION.md)** — architecture, database schema, the OAuth2 flow end to end, per-file reference, and maintenance runbook.
- **[DEPLOY.md](DEPLOY.md)** — deploying to Render with TiDB Cloud.

## License

MIT
