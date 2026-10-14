# Dexcom EGV Tester — Technical Documentation

**Version**: 2.3  
**Last Updated**: October 14, 2026

---

## 1. Overview

The Dexcom EGV Tester is a full-stack web application designed to authenticate with the Dexcom CGM (Continuous Glucose Monitor) API via OAuth2 and retrieve Estimated Glucose Values (EGVs). It provides a developer-focused interface for testing both the Dexcom Sandbox and Production API environments, visualizing glucose data on an interactive timeline chart, and exporting results in multiple formats.

The whole application sits behind a sign-in with two roles (§7.8): a **viewer** password opens the EGV Data tab and the live reading, and an **admin** password also opens Connect and API Info. It remains single-tenant: one set of OAuth tokens is stored per environment (Sandbox and Production), so the last admin to authenticate "owns" the active connection.

The official API delays data by an hour. In Production the app can also read the CGM wearer's **Dexcom Share** feed — the service behind the Dexcom Follow app — to show the current reading and extend the chart to the present (§3.4, §7.7).

---

## 2. Architecture

The application follows a standard three-tier architecture with a React frontend, a Node.js/Express backend, and a MySQL-compatible database.

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Client)                    │
│  React 19 + Tailwind CSS 4 + Recharts + tRPC Client     │
└──────────────────────┬──────────────────────────────────┘
                       │  HTTP: /login, tRPC over /api/trpc,
                       │  Express routes (/api/dexcom/*)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  Node.js Server (Backend)               │
│  Express 4 + tRPC 11 + Axios + Drizzle ORM              │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Sign-in gate (_core/session.ts), every request    │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ tRPC Router │  │ Dexcom OAuth │  │ Share client   │  │
│  │ (procedures)│  │ (Express)    │  │ (dexcomShare)  │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬───────┘  │
│         │                │                   │          │
│         ▼                ▼                   │          │
│  ┌────────────────────────────────────┐      │          │
│  │ Dexcom Service Layer (dexcom.ts)   │      │          │
│  │ Tokens, refresh, official API      │      │          │
│  └─────────────────┬──────────────────┘      │          │
└────────────────────┼─────────────────────────┼──────────┘
                     │                         │
          ┌──────────┴──────────┐              │
          ▼                     ▼              ▼
┌─────────────────┐ ┌───────────────────────┐ ┌──────────────────┐
│ TiDB Cloud      │ │ Dexcom API            │ │ Dexcom Share     │
│ Dexcom OAuth    │ │ api.dexcom.com        │ │ share2.dexcom.com│
│ tokens          │ │ sandbox-api.dexcom.com│ │ (unofficial)     │
└─────────────────┘ └───────────────────────┘ └──────────────────┘
```

### Request Flow Summary

Every request first passes the sign-in gate (`requireSession`, §7.8); only `/login` itself is exempt. Past the gate, all frontend-to-backend communication uses **tRPC** (type-safe RPC over HTTP), except for the Dexcom OAuth redirect flow which uses standard Express GET routes. The backend proxies all Dexcom API calls, ensuring the Client Secret never reaches the browser. Tokens are stored in the database and automatically refreshed when they expire (with a 60-second buffer). Live readings come from Dexcom Share through `dexcom.latest`; the Share credentials, like the Client Secret, never leave the server.

---

## 3. External Services

The application depends on three external services, plus an optional fourth for live data. The table below summarizes each service, its role, and the credentials required.

| Service | Purpose | Credentials Required | Free Tier |
|---------|---------|---------------------|-----------|
| **Dexcom API** | OAuth2 authentication and EGV data retrieval | `DEXCOM_CLIENT_ID`, `DEXCOM_CLIENT_SECRET` | Yes (Sandbox is free; Production requires approval) |
| **TiDB Cloud** | MySQL-compatible database for storing OAuth tokens | `DATABASE_URL` (connection string) | Yes (Serverless Starter: 5 GiB storage, 50M Request Units/month) |
| **Render** | Web hosting and deployment | GitHub connection | Yes (Free tier: 750 hours/month, auto-sleep after 15 min inactivity) |
| **Dexcom Share** (optional) | Near-real-time readings for the live card and chart (§3.4) | `DEXCOM_SHARE_USERNAME`, `DEXCOM_SHARE_PASSWORD` — the CGM wearer's own Dexcom login | Free; unofficial, no developer account |

### 3.1 Dexcom API

The Dexcom API [1] provides programmatic access to CGM data. The application uses two environments:

| Environment | Base URL | Purpose |
|-------------|----------|---------|
| **Sandbox** | `https://sandbox-api.dexcom.com` | Testing with simulated data from predefined test users |
| **Production** | `https://api.dexcom.com` | Real patient data (requires Dexcom approval) |

The following Dexcom API endpoints are used:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v3/oauth2/login` | GET | Initiates the OAuth2 authorization flow (user redirect) |
| `/v3/oauth2/token` | POST | Exchanges authorization codes for tokens, and refreshes expired tokens |
| `/v3/users/self/egvs` | GET | Retrieves Estimated Glucose Values for a date range (max 30 days) |
| `/v3/users/self/dataRange` | GET | Returns the available date range for the connected user's data |

The Dexcom API enforces a **maximum 30-day query window** per request. Dates must be in ISO 8601 format. The application validates this constraint on both the frontend and backend before making API calls.

### 3.2 TiDB Cloud

TiDB Cloud [2] provides a MySQL-compatible serverless database. The application uses it to persist Dexcom OAuth tokens (access token, refresh token, expiration time) so that users do not need to re-authenticate on every visit. The connection requires TLS/SSL, which is enforced by appending `?ssl={"rejectUnauthorized":true}` to the connection string.

### 3.3 Render

Render [3] hosts the application as a Node.js web service. The `render.yaml` file in the repository root provides a declarative deployment configuration (Infrastructure as Code). On the free tier, the service will spin down after 15 minutes of inactivity and cold-start on the next request (which may take 30–60 seconds).

### 3.4 Dexcom Share (optional)

The official API delays data from the Dexcom mobile apps by one hour in the US and three hours elsewhere [4]; only data uploaded from a receiver over USB arrives sooner. Dexcom's real-time partner APIs are limited to commercial partners. **Dexcom Share**, the service the Dexcom Follow app reads from, has no delay, and it is what third-party live views such as Nightscout's Share bridge and xDrip use. It is **unofficial and undocumented**: the endpoints and application ID below come from the open-source pydexcom project [5], and Dexcom can change or block them at any time.

`server/dexcomShare.ts` signs in with the CGM wearer's own Dexcom username and password. A follower's login does not work, and Share must be on in the wearer's app with at least one follower. There are three requests, all `POST` with JSON, under `https://share2.dexcom.com/ShareWebServices/Services/`:

| Step | Endpoint | Sends | Returns |
|------|----------|-------|---------|
| 1 | `General/AuthenticatePublisherAccount` | `accountName`, `password`, `applicationId` | Account ID |
| 2 | `General/LoginPublisherAccountById` | `accountId`, `password`, `applicationId` | Session ID |
| 3 | `Publisher/ReadPublisherLatestGlucoseValues` | `sessionId`, `minutes`, `maxCount` as query parameters, with an empty body | Readings, newest first |

Share reaches back 24 hours at most (`minutes` ≤ 1440, `maxCount` ≤ 288), and the client always asks for all of it. Each reading has `WT`, `ST` and `DT` timestamps such as `Date(1691455258000)` — epoch milliseconds, with `DT` adding the phone's UTC offset — plus `Value` and a PascalCase `Trend`. `parseShareReadings()` converts them to the official record shape: `WT` becomes `systemTime`, `DT` becomes `displayTime`, `FortyFiveUp` becomes `fortyFiveUp`, and each record gets `source: "share"`. Share has no rate of change, so `trendRate` is `null`.

Three rules protect the wearer's account:

- **No retrying a failed sign-in.** Dexcom locks an account after repeated failed sign-ins. A rejected sign-in therefore pauses all attempts for 15 minutes, doubling with each further rejection in a row up to 4 hours, and starting over after a success. If Dexcom couldn't be reached at all, the pause is 2 minutes. The live card shows the reason and when the next attempt will be. An expired session gets exactly one fresh sign-in and one retry.
- **At most one Share read per minute per server.** Results are cached in memory for 60 seconds, and concurrent callers share one request however many tabs are open. The session is held in memory too, so a cold start signs in once.
- **Credentials stay in the environment.** They are never logged, stored in the database, or sent to the browser.

`dexcom.latest` never throws. A Share problem comes back as data — `{ configured: true, readings, fetchedAt, error, retryAt? }`, with the last good readings if there are any — so it cannot take the EGV page down. With the variables unset it returns `{ configured: false }`, and the live card doesn't render.

---

## 4. Database Schema

The database contains six tables managed by Drizzle ORM. Migrations are applied via `pnpm db:push` (which runs `drizzle-kit generate && drizzle-kit migrate`).

### 4.1 `users` Table

Vestigial. It came from the template's authentication scaffolding, which has since been removed — no application code reads or writes this table any more. It is retained only because `dexcom_tokens.userId` is pinned to `1`, and because dropping it would mean a destructive migration against the live database.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INT (auto-increment, PK) | Surrogate primary key |
| `openId` | VARCHAR(64), UNIQUE | OAuth identifier (set to `single-user` in this mode) |
| `name` | TEXT | Display name |
| `email` | VARCHAR(320) | Email address |
| `loginMethod` | VARCHAR(64) | Authentication method used |
| `role` | ENUM(`user`, `admin`) | User role (defaults to `user`) |
| `createdAt` | TIMESTAMP | Record creation time |
| `updatedAt` | TIMESTAMP | Last update time (auto-updated) |
| `lastSignedIn` | TIMESTAMP | Last sign-in time |

### 4.2 `dexcom_tokens` Table

Stores Dexcom OAuth tokens per environment. In single-user mode, `userId` is always `1`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INT (auto-increment, PK) | Surrogate primary key |
| `userId` | INT | References `users.id` (always `1` in single-user mode) |
| `accessToken` | TEXT | Dexcom OAuth access token |
| `refreshToken` | TEXT | Dexcom OAuth refresh token (used to obtain new access tokens) |
| `expiresAt` | TIMESTAMP | When the current access token expires |
| `sandboxUser` | VARCHAR(64) | Which sandbox test user was selected (sandbox only) |
| `environment` | ENUM(`sandbox`, `production`) | Which Dexcom environment this token belongs to |
| `createdAt` | TIMESTAMP | Record creation time |
| `updatedAt` | TIMESTAMP | Last update time (auto-updated) |

The combination of `userId` + `environment` is unique in practice — each environment stores exactly one set of tokens.

### 4.3 Apple Health Tables

**No longer used.** Health Correlations, the only feature that read or wrote these tables, was removed in October 2026 (§7.5). They still hold the last import, and they stay in `drizzle/schema.ts` on purpose: Render's build runs `pnpm db:push`, so removing them from the schema would generate a migration that drops them on the next deploy. Deleting that data is a separate, deliberate decision. The description below is kept for reference.

Three tables hold the results of an Apple Health import. The parsing itself happens in the browser (see §7.5); the server only persists and reads back what the worker sends.

**`health_upload_jobs`** — one row per import, carrying the summary. `fileRef` is always `client-parsed`, and `status` is one of `pending` / `processing` / `completed` / `failed` (client-side parsing writes `completed` directly). Also stores `totalRecordsScanned`, `relevantDataPoints`, `workoutCount`, `metricsFound` (comma-separated), `dataRangeStart` / `dataRangeEnd`, and `bucketCount`.

**`health_buckets`** — one row per metric per 15-minute bucket, keyed by `jobId`. Holds `bucketStart` / `bucketEnd` as ISO strings, the `metric` key, and the `avg` / `min` / `max` / `sum` / `count` aggregates. This is by far the largest table: a multi-year export can produce hundreds of thousands of rows, which is why writes are batched (§7.5).

**`health_workouts`** — one row per workout, keyed by `jobId`: `activityType`, `activityLabel`, `duration`, optional `totalDistance` / `distanceUnit` / `totalEnergyBurned` / `energyUnit`, `startDate`, `endDate`, `sourceName`.

Saving a new import clears all three tables first, so only the most recent import is ever queryable.

### 4.4 `app_settings` Table

Site-wide settings that admins change in the app, one row per setting. Added in October 2026; its migration (`drizzle/0004_amused_betty_brant.sql`) is applied by `pnpm db:push` during the Render build.

| Column | Type | Description |
|--------|------|-------------|
| `name` | VARCHAR(64), PK | Setting key. Today only `chartRange` |
| `value` | TEXT | The value as JSON, e.g. `{"min":40,"max":350}` |
| `updatedAt` | TIMESTAMP | Last change (auto-updated) |

Values are validated where they're read (`server/settings.ts`), so a new setting needs no migration. A missing, unreadable or invalid value falls back to its default rather than failing.

---

## 5. OAuth2 Authentication Flow

The Dexcom OAuth2 flow follows the standard Authorization Code Grant pattern. The application implements this across two Express routes and the Dexcom service layer.

**Step 1 — Authorization Request**: The frontend calls `GET /api/dexcom/authorize?origin=<app_url>&env=<sandbox|production>`. Both OAuth routes require an **admin** session (§7.8) — there is one stored connection, and completing this flow replaces it — so a viewer gets a `403`. The backend generates a random nonce, sets it in a short-lived HttpOnly cookie (`dexcom_oauth_nonce`, scoped to `/api/dexcom/callback`, 10 minutes), and constructs the Dexcom authorization URL with the Client ID, redirect URI, and a Base64-encoded `state` parameter containing the origin URL, environment and nonce. The frontend then redirects the user's browser to this URL.

**Step 2 — User Authorization**: The user signs in on Dexcom's website. In sandbox mode, they select a test user from a dropdown. In production mode, they enter their real Dexcom account credentials.

**Step 3 — Callback**: Dexcom redirects back to `GET /api/dexcom/callback?code=<auth_code>&state=<state>`. The backend decodes the state and compares its nonce with the cookie in constant time, clearing the cookie either way so each nonce works once. A callback without an admin session, or whose nonce doesn't match — a link someone else started, say — is refused before any code is exchanged. Otherwise the backend exchanges the authorization code for an access token and refresh token via a POST to Dexcom's token endpoint.

**Step 4 — Token Storage**: The tokens are saved to the `dexcom_tokens` table in the database, keyed by `userId` (always `1`) and `environment`.

**Step 5 — Redirect**: The user is redirected back to the app with `?dexcom_connected=true&env=<env>` in the URL. Every redirect from the callback is relative, so nothing in the echoed `state` can send the browser to another site. The frontend detects this, shows a success toast, and switches to the correct environment tab.

**Token Refresh**: When a tRPC procedure needs an access token, it calls `getValidAccessToken()`. If the stored token expires within 60 seconds, the function automatically refreshes it using the refresh token and updates the database. This is transparent to the user.

**Timeouts**: every request to Dexcom gives up after 20 seconds (`DEXCOM_TIMEOUT_MS` in `server/dexcom.ts`), so an outage fails fast instead of holding requests and their memory open.

**Error Handling**: If the token exchange fails (e.g., "max user count exceeded"), the backend extracts a human-readable error from Dexcom's response (which can come in multiple formats) and redirects with `?dexcom_error=<message>&env=<env>`. The frontend displays this as a toast notification.

---

## 6. Key File Reference

The table below maps each significant file to its responsibility in the application.

| File Path | Responsibility |
|-----------|---------------|
| `server/dexcom.ts` | Core Dexcom service layer — OAuth URL generation, token exchange, token refresh, token storage/retrieval, EGV and data range API calls. Every request has a 20-second timeout, and `describeDexcomError()` turns failures into secret-free log lines |
| `server/dexcomRoutes.ts` | Express routes for the OAuth flow (`/api/dexcom/authorize`, `/api/dexcom/callback`) — admin only, with the `state` nonce check (§5) |
| `server/routers.ts` | tRPC router definitions — `auth.me` / `auth.logout`, and the `dexcom.*` procedures (`status`, `disconnect`, `dataRange`, `egvs`, `latest`), each declared as viewer or admin; plus `settings.get` (viewer) and `settings.setChartRange` (admin) |
| `server/settings.ts` | Site-wide settings in `app_settings` (§4.4): `getChartRange()` / `saveChartRange()` and the `chartRangeSchema` validation |
| `server/dexcomShare.ts` | Dexcom Share client (§3.4) — sign-in sequence, 60-second cache, sign-in back-off, and the reading parser. `getLatestShareResult()` backs `dexcom.latest` |
| `server/db.ts` | Lazy Drizzle connection helper (`getDb()`). Returns `null` when `DATABASE_URL` is unset, so local tooling runs without a database |
| `server/_core/index.ts` | Express server entry point — registers the sign-in routes and gate first, then tRPC middleware, Dexcom routes, and Vite dev middleware |
| `server/_core/session.ts` | Site sign-in (§7.8) — password-to-role check, signed session cookies, the `requireSession` gate, the failed-attempt limiter, and the self-contained sign-in page |
| `server/_core/trpc.ts` | tRPC setup and the `viewerProcedure` / `adminProcedure` guards |
| `server/_core/env.ts` | Reads `DEXCOM_CLIENT_ID`, `DEXCOM_CLIENT_SECRET` and the Dexcom Share credentials from the environment (the sign-in variables are read in `session.ts`) |
| `drizzle/schema.ts` | Database table definitions (`users`, `dexcom_tokens`, `app_settings`, and the unused Apple Health tables in §4.3) using Drizzle ORM |
| `shared/const.ts` | Shared constants — Dexcom base URLs, environment types, timezone mode type, and the default chart range and its limits |
| `client/src/main.tsx` | tRPC client — sends `dexcom.latest` outside the request batch (§7.7), and sends the browser to sign-in on a `401` |
| `client/src/pages/Home.tsx` | Main UI — live card, tabbed interface (Connect, EGV Data, API Info) with the admin-only tabs locked for viewers, environment and timezone toggles, date inputs, export buttons, sign-out |
| `client/src/components/LiveGlucoseCard.tsx` | Current-reading card above the tabs (§7.7) |
| `client/src/components/EgvChart.tsx` | Recharts-based glucose timeline chart with target range highlighting and trend tooltips; live readings are a dashed second series; takes the vertical range as a prop (§7.3) |
| `client/src/lib/mergeLiveReadings.ts` | Splices live readings onto official EGV records, with the consistency guard (§7.7) |
| `client/src/lib/glucose.ts` | Glucose colour bands, trend arrows and `parseUtc()`, shared by the chart and the live card |
| `client/src/components/JsonViewer.tsx` | Syntax-highlighted JSON viewer for raw API responses, with a size cap (§7.6) |
| `client/src/lib/timezone.ts` | Timezone conversion utilities — UTC/local formatting, input-to-API date conversion |
| `client/src/components/ChartRangeControl.tsx` | Admin-only popover for setting the chart's vertical range (§7.3) |
| `client/src/lib/chartAxis.ts` | The chart's vertical range and ticks, and the timings that draw the official and live series as one stroke |
| `client/src/lib/queryWindow.ts` | The default query window: the last 24 hours, ending at the current minute |
| `client/src/lib/export.ts` | Export utilities — CSV (with a `source` column), JSON, and PNG (SVG-to-Canvas) chart export |
| `render.yaml` | Render deployment configuration (Infrastructure as Code) |
| `DEPLOY.md` | Step-by-step deployment guide for Render + TiDB Cloud |

---

## 7. Frontend Features

### 7.1 Environment Toggle

A toggle in the header switches between **Sandbox** and **Production** environments. The application **defaults to Production** on page load. Each environment maintains independent OAuth tokens and connection state. Production mode displays a warning banner reminding users that real patient data is being accessed. The live card and live data (§7.7) appear only in Production.

### 7.2 Timezone Selector

A UTC/Local toggle in the header controls how all dates and times are displayed throughout the application. In UTC mode, all timestamps are shown in ISO 8601 UTC format. In Local mode, timestamps are converted to the user's browser timezone (e.g., EST). The date input fields, chart X-axis labels, chart tooltips, and data table all respect this setting. Regardless of display mode, all dates are converted to UTC before being sent to the Dexcom API.

### 7.3 EGV Data Visualization

The glucose chart uses Recharts to render an interactive timeline with the following visual elements:

| Element | Description |
|---------|-------------|
| Green shaded area (80–180 mg/dL) | Target glucose range |
| Amber dashed lines (80, 180) | Low and high thresholds |
| Red dashed line (54) | Urgent low threshold |
| Teal line | Glucose readings over time |
| Dashed teal line | Live readings from Dexcom Share, continuing from the last official reading (§7.7) |
| Hover tooltip | Shows exact value, time, trend arrow, and rate of change. Live readings are labelled "Live · Dexcom Share" and have no rate of change |
| **Average glucose badge** | Displayed next to the chart title, color-coded: green (80–180), red (<80), amber (>180). Includes live readings |

**Vertical range**: 40–350 mg/dL unless an admin has set another, using the range button (with a sliders icon) beside the chart title. The setting is stored on the server (§4.4), so it applies to everyone, and is limited to 0–500 mg/dL with at least 50 between the ends. The axis still widens to fit any reading outside the range, so a reading is never clipped. Ticks fall on round numbers: every 25, 50 or 100 mg/dL, depending on the span.

**Draw-in**: the chart animates in left to right as one stroke. The solid official line takes its share of the 1.5 seconds, and the dashed live tail starts where it ends (`drawTimings` in `client/src/lib/chartAxis.ts`). Left to Recharts' defaults, each series would animate along its own path at once, so the short live tail at the right edge appeared before the rest.

The chart X-axis uses **smart axis labels** that adapt to the date range being displayed. When the data spans a single day or less, only times are shown (e.g., "02:30 PM"). When the data spans multiple days, the axis switches to a date+time format (e.g., "01/15 14:30") with slightly angled labels to prevent overlap.

**Loading state**: while a query is in flight the chart is replaced by a placeholder card of identical height (`h-80`), carrying the section header, a stand-in for the average-glucose badge, and a status line naming the range being fetched ("Fetching 28 days of EGV data..."). Reserving the exact height means the page does not shift when the real chart arrives.

The placeholder's animations are deliberately restricted to `opacity` and `transform` — `animate-pulse` on the placeholders, `animate-spin` on the status icon. This is a constraint, not a style choice. A wide query spends a substantial part of its wait with the main thread blocked (on a 28-day fetch, around 8,000 records, the longest single block measured was ~1.8s), and only compositor-driven properties keep animating through that. An indicator driven by JavaScript, or one animating a property that triggers layout or paint, would freeze during precisely the stretch where feedback matters most. Anything replacing this placeholder should preserve that restriction.

### 7.4 Export Options

Three export formats are available once EGV data is loaded:

| Format | Contents | Filename Pattern |
|--------|----------|-----------------|
| **CSV** | All EGV record fields plus a formatted display time column, and a final `source` column (`official` or `share`) | `dexcom-egvs_<env>_<timestamp>.csv` |
| **JSON** | Raw Dexcom API response with pretty-print indentation — official data only, without live readings | `dexcom-egvs_<env>_<timestamp>.json` |
| **PNG** | Glucose chart with metadata header (date range, average glucose, record count) rendered at 2x resolution via SVG-to-Canvas | `dexcom-chart_<env>_<timestamp>.png` |

The PNG export includes a header above the chart containing: the chart title with timezone label, the average glucose value (color-coded by range), formatted start and end dates, the date range duration (hours or days), the total record count (and how many are live), and the environment label (Production or Sandbox).

### 7.5 Apple Health Correlations (removed)

Removed in October 2026. Opening the tab made the server load the entire stored import in one response, and on Render's free instance that ran out of memory: replayed on ~284,000 synthetic rows, the `appleHealth.buckets` response alone needed ~430MB at its peak, most of it in superjson serialization. The feature wasn't being used, so it went rather than being rebuilt.

The code is in git history, last present at commit `7fd94e1` (the page, chart, Web Worker, ZIP/XML parser, server procedures and their tests). Anyone restoring it should load buckets for the selected date range only, and keep large payloads out of superjson. The stored data is still in the tables described in §4.3.

### 7.6 Raw Response Viewer

Every API response is shown in a collapsible, syntax-highlighted viewer (`client/src/components/JsonViewer.tsx`).

Highlighting injects roughly one `<span>` per token, so its cost scales with the size of the payload rather than with how much of it is on screen. A 28-day EGV response is around 8,000 records — about 4 MB of pretty-printed JSON, which previously became ~261,000 DOM nodes and blocked the main thread for roughly nine seconds, long enough that the chart below it never got a chance to paint.

The viewer therefore highlights at most 60 KB, snapped to a line boundary, and shows a `Showing first N of M lines` notice. Two escape hatches keep the full payload reachable:

- **Show all (plain text)** renders the entire response unhighlighted. A multi-megabyte payload stays a single text node instead of hundreds of thousands of elements, which costs a few hundred milliseconds rather than seconds.
- **Copy** always copies the complete response, regardless of what is displayed.

Responses under the cap are unaffected — they render fully highlighted with no notice and no toggle.

### 7.7 Live Data (Dexcom Share)

In Production, with the Share variables set (§3.4), two things change.

**Current-glucose card.** `LiveGlucoseCard` sits above the tabs, so it stays visible even if the OAuth connection lapses. It shows the newest reading, colour-coded with the chart's bands, with its trend arrow and age ("3 min ago"), and always carries the line "For reference only — not for treatment decisions." A reading more than 15 minutes old is dimmed, with a "check the phone and sensor" notice; a paused or failed Share sign-in shows the reason and when it will try again. The card polls `dexcom.latest` every 60 seconds, **only while the tab is visible**, so a background tab neither spends Share reads nor keeps Render's free instance awake. `dexcom.latest` is sent outside the tRPC batch (`splitLink` in `client/src/main.tsx`): a batch is answered only when every call in it finishes, and a Share sign-in on a cold start must not hold up the rest of the page.

**Chart gap-fill.** `mergeLiveReadings()` appends Share readings to the official records, which end about an hour ago:

- It adds only readings more than 2.5 minutes after the last official one, so nothing is duplicated or replaced. The two sources stamp the same reading a few seconds apart, which is why the seam is a window rather than an instant.
- It stays inside the query window. A window that ended within 15 minutes of when it was fetched counts as "up to now", and keeps growing as new readings arrive for as long as the page is open.
- **Consistency guard.** Share signs in with its own credentials, separate from the OAuth connection, so a misconfiguration could stitch two people's data together. Before merging, each Share reading in the overlap is paired with the official reading within ±2.5 minutes of it; given at least 3 pairs, their median difference must be no more than 3 mg/dL. Otherwise nothing is merged, and the chart shows a warning. The default 24-hour window has about 23 hours of overlap, so the guard normally has plenty to compare.
- Never in Sandbox, whose data is synthetic: live data is real and must not be mixed into it.

Live points are drawn as a dashed line continuing from the last official point, and their tooltip says "Live · Dexcom Share". The record badge ("36 records · 12 live"), the average, the CSV export and the PNG header include them; the JSON export and the raw-response viewer remain the untouched official response.

**Default range.** In Production the date inputs default to the last 24 hours, ending at the current minute (`lastHoursWindow` in `client/src/lib/queryWindow.ts`). Until someone edits a date, Fetch re-measures that window from the moment it's clicked, so a page left open still fetches the true last 24 hours. Edited dates are left alone, and switching environment resets the default. Sandbox data isn't live, so there the default is the last 24 hours of its data, applied once its data range arrives. The "Available range" line notes how far live data reaches.

### 7.8 Sign-in and Roles

The site's address isn't secret and its data is real, so the whole application sits behind a password. `server/_core/session.ts` enforces it on the server, ahead of tRPC, the Dexcom routes, Vite and the static files, so no page, bundle or API response reaches a signed-out browser.

| Role | Password | Opens | Session lasts |
|------|----------|-------|---------------|
| **Viewer** | `VIEWER_PASSWORD` | EGV Data tab and the live card | 90 days |
| **Admin** | `ADMIN_PASSWORD` | Everything, including Connect and API Info | 30 days |

- **One sign-in page, one password box** (`/login`). Whichever password matches decides the role, and both comparisons always run, in constant time. The page is self-contained HTML with no scripts, served with `noindex` and `no-store` headers.
- **Admin tabs** show a viewer an "Admin only" card, with a password box that upgrades the session in place. The server enforces the same split independently of the UI: `dexcom.disconnect` and `settings.setChartRange` are `adminProcedure`s (`server/_core/trpc.ts`), and both OAuth routes check for admin too, so a viewer can neither change nor take over the Dexcom connection.
- **Sessions** are a signed cookie, `app_session_id`, holding the role and issue time with an HMAC-SHA256 under `SESSION_SECRET`. It is HttpOnly, `SameSite=Lax`, and Secure over HTTPS. The key is random rather than derived from a password, so a cookie reveals nothing about either password. Changing `SESSION_SECRET` signs everyone out; removing `ADMIN_PASSWORD` turns admin sessions into viewer sessions.
- **Rate limits**: after 10 failed sign-ins from one address within 15 minutes, further attempts from it are refused until the window passes. Behind Render's proxy the address comes from `X-Forwarded-For`, and a client can add its own entries to that header, so there is also an overall cap: 30 failed sign-ins from anywhere within 15 minutes pause all new sign-ins for the rest of that window. That bounds guessing however the header is forged, and existing sessions are unaffected. Both counts are held in memory.
- **Signed-out requests**: pages redirect to `/login?next=…`, where `next` must be a same-site path, so the redirect can't be used to send someone elsewhere. API calls get a `401`, and the client sends the browser to sign-in when it sees one.
- **Fail closed.** In production, a missing `VIEWER_PASSWORD` or `SESSION_SECRET` shows a "not configured" page (HTTP 503) rather than serving the site openly. In development, an unset `VIEWER_PASSWORD` disables sign-in with a warning at startup, and every visitor is treated as admin.

---

## 8. Environment Variables

The application requires the following environment variables in production. These are configured in Render's Environment settings.

| Variable | Required | Description | Where to Obtain |
|----------|----------|-------------|-----------------|
| `DATABASE_URL` | Yes | MySQL connection string with TLS | TiDB Cloud dashboard > Connect > Connection String |
| `DEXCOM_CLIENT_ID` | Yes | Dexcom developer app Client ID | [Dexcom Developer Portal](https://developer.dexcom.com) > My Apps |
| `DEXCOM_CLIENT_SECRET` | Yes | Dexcom developer app Client Secret | [Dexcom Developer Portal](https://developer.dexcom.com) > My Apps |
| `NODE_ENV` | Yes | Must be `production` for deployed builds | Set to `production` in Render |
| `PORT` | No | Server port (Render sets this automatically) | Managed by Render |
| `VIEWER_PASSWORD` | Yes | Opens the site as a viewer (§7.8) | Choose one, and share it with viewers |
| `ADMIN_PASSWORD` | Recommended | Also opens the admin tabs; without it they stay locked | Choose one, different from the viewer password |
| `SESSION_SECRET` | Yes | Random key that signs session cookies | `render.yaml` has Render generate it; or use `openssl rand -hex 32` |
| `DEXCOM_SHARE_USERNAME` | No | The CGM wearer's Dexcom username; enables live data (§3.4) | The wearer's own Dexcom account, with their agreement |
| `DEXCOM_SHARE_PASSWORD` | No | Password for that account | As above |

Production refuses to serve the site without `VIEWER_PASSWORD` and `SESSION_SECRET`, so set them **before** deploying a version with sign-in.

---

## 9. Dexcom Redirect URI Configuration

The Dexcom OAuth flow requires a **Redirect URI** registered in your Dexcom developer app settings. This URI must exactly match the callback URL the application uses.

| Hosting Environment | Redirect URI |
|--------------------|--------------|
| Render (production) | `https://dexcom-egv-tester.onrender.com/api/dexcom/callback` |
| Local development | `http://localhost:3000/api/dexcom/callback` |

You can register multiple redirect URIs in the Dexcom developer portal simultaneously. The application dynamically constructs the correct callback URL based on the `origin` parameter passed during the authorization request.

---

## 10. Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Frontend framework** | React | 19.2 | UI rendering and component architecture |
| **Styling** | Tailwind CSS | 4.1 | Utility-first CSS framework |
| **UI components** | shadcn/ui (Radix primitives) | Various | Accessible, composable UI components |
| **Charting** | Recharts | 2.15 | Interactive glucose timeline chart |
| **Client-server RPC** | tRPC | 11.6 | Type-safe API calls between frontend and backend |
| **Data fetching** | TanStack React Query | 5.90 | Server state management, caching, and refetching |
| **Routing** | Wouter | 3.3 | Lightweight client-side routing |
| **Backend framework** | Express | 4.21 | HTTP server and middleware |
| **HTTP client** | Axios | 1.12 | Server-side HTTP requests to Dexcom API |
| **ORM** | Drizzle ORM | 0.44 | Type-safe database queries and schema management |
| **Database driver** | mysql2 | 3.15 | MySQL/TiDB connection driver |
| **Schema validation** | Zod | 4.1 | Input validation for tRPC procedures |
| **Serialization** | SuperJSON | 1.13 | Preserves Date objects across tRPC boundary |
| **Build tool** | Vite | 7.1 | Frontend bundling and dev server |
| **Server bundler** | esbuild | 0.25 | Server-side code bundling for production |
| **TypeScript** | TypeScript | 5.9 | Type safety across the full stack |
| **Testing** | Vitest | 2.1 | Unit testing framework |
| **Package manager** | pnpm | 10.4 | Fast, disk-efficient package management |

---

## 11. Common Maintenance Tasks

### 11.1 Updating Credentials and Passwords

If your Dexcom Client ID or Secret changes, update the `DEXCOM_CLIENT_ID` and `DEXCOM_CLIENT_SECRET` environment variables in Render's dashboard (Settings > Environment). The service will automatically redeploy.

The same goes for `VIEWER_PASSWORD`, `ADMIN_PASSWORD` and the Share credentials. Changing a password does **not** end sessions already signed in with it; to sign everyone out, after a password leaks for example, also change `SESSION_SECRET`. If the CGM wearer changes their Dexcom password, update `DEXCOM_SHARE_PASSWORD` promptly: until then every Share sign-in fails, and although the back-off (§3.4) holds that to a few attempts a day, repeated failures are exactly what Dexcom locks accounts for.

### 11.2 Rotating the Database Password

If you rotate the TiDB Cloud password, update the `DATABASE_URL` environment variable in Render with the new connection string. Ensure the `?ssl={"rejectUnauthorized":true}` suffix is preserved.

### 11.3 Adding New Dexcom API Endpoints

To add support for additional Dexcom endpoints (e.g., Calibrations, Devices, Events, Alerts):

1. Add a new fetch function in `server/dexcom.ts` following the pattern of `fetchEgvData()`.
2. Add a new tRPC procedure in `server/routers.ts` under the `dexcom` router.
3. Add a new UI tab or section in `client/src/pages/Home.tsx` that calls the new procedure.
4. Write a vitest test in `server/dexcom.routers.test.ts` for the new procedure.

### 11.4 Switching to Multi-User Mode

To support multiple users with independent Dexcom connections, you would need to:

1. Add an auth provider (Auth0, Clerk, email/password — anything) in place of the two shared passwords in `server/_core/session.ts`. Today the session cookie carries only a role: `TrpcContext` holds `req`, `res` and that `role`, and `auth.me` returns `{ role, adminEnabled, signInRequired }`.
2. Put the authenticated user on the tRPC context in `server/_core/context.ts`, alongside the role, and scope procedures by user where `viewerProcedure` / `adminProcedure` in `server/_core/trpc.ts` scope them by role today.
3. Replace the `SINGLE_USER_ID = 1` constant in `server/routers.ts` and `server/dexcomRoutes.ts` with that user's ID.
4. No schema change is needed — `dexcom_tokens.userId` already scopes tokens per user. The `users` table (§4.1) would become live again.

Note that Dexcom Share (§3.4) is configured for a single wearer through environment variables.

### 11.5 Monitoring and Logs

Render provides built-in logging. You can view server logs in the Render dashboard under your service's **Logs** tab. Key log prefixes to watch for:

| Log Prefix | Meaning |
|------------|---------|
| `[Dexcom] Callback error:` | OAuth token exchange failed. The line gives Dexcom's HTTP status and error, or the network error code — never the request itself, which carries the client secret |
| `[Dexcom] Failed to refresh token` | Token refresh failed, summarised the same way — the connection may need re-authorizing |
| `[Database] Failed to connect:` | Database connection issue — verify `DATABASE_URL` |
| `[Auth] Site locked: missing …` | Production is missing `VIEWER_PASSWORD` or `SESSION_SECRET`; the site shows "not configured" until they're set |
| `[Auth] ADMIN_PASSWORD is not set` | The admin tabs are locked for everyone |
| `[Auth] VIEWER_PASSWORD and ADMIN_PASSWORD are identical` | Everyone who signs in gets admin — set two different passwords |
| `[Auth] Failed sign-in` / `Failed admin sign-in` | A wrong password was entered; 10 from one address, or 30 overall, within 15 minutes trigger the rate limits |
| `[Auth] Too many failed sign-ins overall` | 30 failures in 15 minutes, most likely someone guessing. New sign-ins are refused until the window passes; existing sessions keep working |
| `[Share] Sign-in failed (<code>); pausing sign-in attempts for N minutes` | Dexcom Share rejected the sign-in or didn't answer. A rejection usually means `DEXCOM_SHARE_PASSWORD` is out of date (§11.1) |
| `[Share] Read failed:` | A Share read failed for another reason; the live card keeps showing the last good readings |

### 11.6 Cold Starts on Free Tier

Render's free tier spins down the service after 15 minutes of inactivity. The first request after a cold start may take 30–60 seconds. If this is unacceptable, consider upgrading to Render's paid tier ($7/month for the Starter plan) which keeps the service running continuously.

A visible tab showing the live card polls once a minute, which keeps the instance awake while it's open. The free tier's 750 instance hours a month cover one service running nonstop, but they are shared by every free service in the Render workspace.

### 11.7 Running Tests

Run the full test suite with:

```bash
pnpm test
```

There are 135 tests across eleven files:

| File | Tests | Covers |
|------|-------|--------|
| `server/settings.test.ts` | 17 | Chart-range validation, reading with fallbacks (nothing saved, unreadable or invalid value, unreadable table, no database), saving, and the viewer/admin split on the procedures |
| `server/session.test.ts` | 31 | Auth-state resolution (fail-closed in production, open in development), passwords to roles, session tokens (signing, tampering, expiry), `next` validation, the per-address and overall sign-in limits, and the gate and sign-in handlers |
| `server/dexcomShare.test.ts` | 25 | The Share sign-in sequence and its exact request bodies, session expiry, the sign-in back-off, caching and request coalescing, timestamp and trend parsing, and `dexcom.latest` |
| `client/src/lib/mergeLiveReadings.test.ts` | 18 | Windowing, de-duplication at the seam, ordering, the consistency guard, open-ended windows, and Sandbox exclusion |
| `server/dexcom.routers.test.ts` | 12 | Role checks on the `dexcom` procedures, their behaviour and date-range validation, and `auth.me` |
| `server/dexcom.test.ts` | 7 | Every Dexcom request has a timeout, and failed token requests are logged as one line without the client secret or tokens |
| `client/src/lib/chartAxis.test.ts` | 9 | Vertical range widening, tick steps, and the draw timings that start the live tail where the official line ends |
| `client/src/lib/queryWindow.test.ts` | 2 | The default 24-hour window and its rounding to the minute |
| `client/src/lib/export.test.ts` | 11 | CSV / JSON / PNG export helpers, including the `source` column |
| `server/dexcom.credentials.test.ts` | 2 | Dexcom credentials are configured |
| `server/auth.logout.test.ts` | 1 | Session cookie is cleared on logout |

**Two of these fail without Dexcom credentials**: both `dexcom.credentials` tests assert the `DEXCOM_*` variables are non-empty. A clean local run is therefore **133 passed / 2 failed** — treat that as the baseline rather than a regression. Nothing else needs a database or network: the router tests mock `getDb()`, the Share client tests use a scripted transport, and the `dexcom.latest` tests blank the Share credentials, so no test contacts Dexcom.

### 11.8 Local Development

To run the application locally:

```bash
# Install dependencies
pnpm install

# Set environment variables: copy the template and fill in what you need
cp .env.example .env

# Start the dev server (hot-reloading enabled)
pnpm dev
```

The dev server prefers port 3000 but scans upward for the first free port (`findAvailablePort` in `server/_core/index.ts`), so check the `Server running on ...` line for the actual URL. Remember to add `http://localhost:<port>/api/dexcom/callback` as a redirect URI in your Dexcom developer app settings for local testing.

Without a `DATABASE_URL` the app still boots and the Connect and API Info tabs render, but `getDb()` returns `null`, so the connection status is always disconnected and the EGV Data tab stays disabled.

Without `VIEWER_PASSWORD` the dev server skips sign-in and treats every visitor as admin, logging a warning at startup. Set it, and optionally `ADMIN_PASSWORD`, to try the sign-in flow; `SESSION_SECRET` is optional in development, where sessions just don't survive a restart. Live data needs the Share variables. Set them only with the wearer's agreement, and never try a wrong password against a real account (§3.4).

---

## 12. References

[1]: https://developer.dexcom.com/docs "Dexcom Developer API Documentation"
[2]: https://tidbcloud.com/docs "TiDB Cloud Documentation"
[3]: https://docs.render.com "Render Documentation"
[4]: https://developer.dexcom.com/docs/dexcomv3/endpoint-overview "Dexcom API v3 — Endpoint Overview (data delay)"
[5]: https://github.com/gagebenne/pydexcom "pydexcom — Python API for Dexcom Share"
