# Dexcom EGV Tester

A developer tool for exercising the [Dexcom API](https://developer.dexcom.com/docs). Authenticate via OAuth2 against the Sandbox or Production environment, pull Estimated Glucose Values, and inspect the raw responses. In Production it can also show the current reading from Dexcom Share, which the official API delays by an hour.

The whole site sits behind a password. A **viewer** password opens the EGV Data tab and the live reading; a separate **admin** password also opens Connect and API Info. One set of OAuth tokens is stored per environment, so the last admin to authenticate owns the active connection.

---

## What it does

- **OAuth2 against either environment** — Sandbox (`sandbox-api.dexcom.com`, test users, no password) or Production (`api.dexcom.com`, real credentials and real patient data). The UI defaults to Production and warns you about it.
- **EGV queries** with a date-range picker that defaults to the last 24 hours, validated against Dexcom's 30-day-per-request cap.
- **Glucose timeline chart** with a vertical range admins can set for everyone, target-range shading, low/high/urgent-low thresholds, trend arrows and rate-of-change on hover, and an average-glucose badge.
- **UTC / local timezone toggle** applied consistently across inputs, axis labels, tooltips and exports. Dates are always converted to UTC before hitting the API.
- **Raw response viewer** with syntax highlighting, so you can see exactly what Dexcom returned.
- **Live current glucose (Production, optional)** — the official API runs an hour behind. With Dexcom Share credentials configured, a card above the tabs shows the latest reading, its trend and its age, refreshed every minute, and queries that run up to the present are extended with Share readings, drawn dashed. Share is unofficial; see [DOCUMENTATION.md §3.4](DOCUMENTATION.md#34-dexcom-share-optional).
- **Sign-in with two roles** — viewer and admin passwords, signed session cookies, and a limit on failed attempts, all enforced on the server for every page and API call. HTTPS is enforced with an HSTS header.
- **Exports** — CSV (with a `source` column marking live readings), raw JSON, and a PNG of the chart with a metadata header.

---

## Quickstart

Requires Node 22.12+ (the test runner needs it; building and running the server work from 20.19) and pnpm.

```bash
pnpm install
```

Copy the template and fill in what you need (see [Environment variables](#environment-variables)):

```bash
cp .env.example .env
```

Without `VIEWER_PASSWORD`, the dev server skips sign-in and treats every visitor as admin. Production never does: it shows a "not configured" page until `VIEWER_PASSWORD` and `SESSION_SECRET` are set.

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
| `pnpm format` | Format with Prettier |
| `pnpm db:push` | Generate and apply Drizzle migrations |

Without a `DATABASE_URL` the app still boots, but the EGV Data tab stays disabled. Without the Dexcom credentials, the two tests in `dexcom.credentials.test.ts` fail. Both are expected locally.

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | MySQL-compatible connection string. Keep the `?ssl={"rejectUnauthorized":true}` suffix for TiDB Cloud. |
| `DEXCOM_CLIENT_ID` | Yes | From the Dexcom developer portal |
| `DEXCOM_CLIENT_SECRET` | Yes | From the Dexcom developer portal |
| `VIEWER_PASSWORD` | Yes in prod | Opens the site: EGV Data and the live card. Without it, production shows a "not configured" page and development skips sign-in. |
| `ADMIN_PASSWORD` | Recommended | Also opens Connect and API Info, which stay locked without it. Make it different from the viewer password. |
| `SESSION_SECRET` | Yes in prod | Random key that signs session cookies. `render.yaml` has Render generate it. Changing it signs everyone out. |
| `DEXCOM_SHARE_USERNAME` | No | The CGM wearer's own Dexcom login (not a follower's). Turns on live data. |
| `DEXCOM_SHARE_PASSWORD` | No | Password for that login. Dexcom locks accounts after repeated failed sign-ins, so keep it current. |
| `NODE_ENV` | Yes in prod | Must be `production` for deployed builds |
| `PORT` | No | Render sets this automatically |

---

## Project layout

```
client/src/
  pages/            Home (tabs), NotFound
  components/       EgvChart, LiveGlucoseCard, ChartRangeControl, JsonViewer, ErrorBoundary, ui/ (shadcn)
  lib/              timezone, export, glucose, mergeLiveReadings, chartAxis, queryWindow, trpc
server/
  dexcom.ts         Dexcom service layer: tokens, refresh, API calls
  dexcomShare.ts    Dexcom Share client for live readings
  settings.ts       Site-wide settings (the chart range), stored in app_settings
  dexcomRoutes.ts   Express OAuth routes (admin only)
  routers.ts        tRPC procedures (auth.*, dexcom.*, settings.*)
  _core/            server entry, sign-in and sessions (session.ts), tRPC setup, Vite middleware
shared/const.ts     Dexcom base URLs and shared types
drizzle/schema.ts   Database tables
```

---

## Documentation

- **[DOCUMENTATION.md](DOCUMENTATION.md)** — architecture, database schema, the OAuth2 flow end to end, Dexcom Share and sign-in, per-file reference, and maintenance runbook.
- **[DEPLOY.md](DEPLOY.md)** — deploying to Render with TiDB Cloud.

## License

MIT
