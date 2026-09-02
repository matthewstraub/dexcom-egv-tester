# Dexcom EGV Tester — Technical Documentation

**Version**: 2.0  
**Last Updated**: September 2, 2026

---

## 1. Overview

The Dexcom EGV Tester is a full-stack web application designed to authenticate with the Dexcom CGM (Continuous Glucose Monitor) API via OAuth2 and retrieve Estimated Glucose Values (EGVs). It provides a developer-focused interface for testing both the Dexcom Sandbox and Production API environments, visualizing glucose data on an interactive timeline chart, exporting results in multiple formats, and correlating glucose data with Apple Health metrics.

The application runs in **single-user mode** — no login or account creation is required. Anyone who visits the app can connect to Dexcom, fetch data, and export results. A single set of OAuth tokens is stored per environment (Sandbox and Production), meaning the last person to authenticate "owns" the active connection.

---

## 2. Architecture

The application follows a standard three-tier architecture with a React frontend, a Node.js/Express backend, and a MySQL-compatible database.

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Client)                    │
│  React 19 + Tailwind CSS 4 + Recharts + tRPC Client     │
└──────────────────────┬──────────────────────────────────┘
                       │  HTTP (tRPC over /api/trpc)
                       │  Express routes (/api/dexcom/*)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  Node.js Server (Backend)               │
│  Express 4 + tRPC 11 + Axios + Drizzle ORM              │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ tRPC Router │  │ Dexcom OAuth │  │ Dexcom API     │  │
│  │ (procedures)│  │ (Express)    │  │ (proxy calls)  │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬───────┘  │
│         │                │                   │          │
│         ▼                ▼                   ▼          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Dexcom Service Layer (dexcom.ts)       │   │
│  │  Token management, API calls, token refresh      │   │
│  └──────────────────────┬───────────────────────────┘   │
└─────────────────────────┼───────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
┌──────────────────────┐  ┌──────────────────────────────┐
│   TiDB Cloud (MySQL) │  │     Dexcom API Servers       │
│   Token storage      │  │  sandbox-api.dexcom.com      │
│   User records       │  │  api.dexcom.com              │
└──────────────────────┘  └──────────────────────────────┘
```

### Request Flow Summary

All frontend-to-backend communication uses **tRPC** (type-safe RPC over HTTP), except for the Dexcom OAuth redirect flow which uses standard Express GET routes. The backend proxies all Dexcom API calls, ensuring the Client Secret never reaches the browser. Tokens are stored in the database and automatically refreshed when they expire (with a 60-second buffer).

---

## 3. External Services

The application depends on three external services. The table below summarizes each service, its role, and the credentials required.

| Service | Purpose | Credentials Required | Free Tier |
|---------|---------|---------------------|-----------|
| **Dexcom API** | OAuth2 authentication and EGV data retrieval | `DEXCOM_CLIENT_ID`, `DEXCOM_CLIENT_SECRET` | Yes (Sandbox is free; Production requires approval) |
| **TiDB Cloud** | MySQL-compatible database for storing OAuth tokens | `DATABASE_URL` (connection string) | Yes (Serverless Starter: 5 GiB storage, 50M Request Units/month) |
| **Render** | Web hosting and deployment | GitHub connection | Yes (Free tier: 750 hours/month, auto-sleep after 15 min inactivity) |

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

---

## 4. Database Schema

The database contains five tables managed by Drizzle ORM. Migrations are applied via `pnpm db:push` (which runs `drizzle-kit generate && drizzle-kit migrate`).

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

Three tables hold the results of an Apple Health import. The parsing itself happens in the browser (see §7.5); the server only persists and reads back what the worker sends.

**`health_upload_jobs`** — one row per import, carrying the summary. `fileRef` is always `client-parsed`, and `status` is one of `pending` / `processing` / `completed` / `failed` (client-side parsing writes `completed` directly). Also stores `totalRecordsScanned`, `relevantDataPoints`, `workoutCount`, `metricsFound` (comma-separated), `dataRangeStart` / `dataRangeEnd`, and `bucketCount`.

**`health_buckets`** — one row per metric per 15-minute bucket, keyed by `jobId`. Holds `bucketStart` / `bucketEnd` as ISO strings, the `metric` key, and the `avg` / `min` / `max` / `sum` / `count` aggregates. This is by far the largest table: a multi-year export can produce hundreds of thousands of rows, which is why writes are batched (§7.5).

**`health_workouts`** — one row per workout, keyed by `jobId`: `activityType`, `activityLabel`, `duration`, optional `totalDistance` / `distanceUnit` / `totalEnergyBurned` / `energyUnit`, `startDate`, `endDate`, `sourceName`.

Saving a new import clears all three tables first, so only the most recent import is ever queryable.

---

## 5. OAuth2 Authentication Flow

The Dexcom OAuth2 flow follows the standard Authorization Code Grant pattern. The application implements this across two Express routes and the Dexcom service layer.

**Step 1 — Authorization Request**: The frontend calls `GET /api/dexcom/authorize?origin=<app_url>&env=<sandbox|production>`. The backend constructs the Dexcom authorization URL with the Client ID, redirect URI, and a Base64-encoded `state` parameter (containing the origin URL and environment). The frontend then redirects the user's browser to this URL.

**Step 2 — User Authorization**: The user signs in on Dexcom's website. In sandbox mode, they select a test user from a dropdown. In production mode, they enter their real Dexcom account credentials.

**Step 3 — Callback**: Dexcom redirects back to `GET /api/dexcom/callback?code=<auth_code>&state=<state>`. The backend decodes the state to recover the origin and environment, then exchanges the authorization code for an access token and refresh token via a POST to Dexcom's token endpoint.

**Step 4 — Token Storage**: The tokens are saved to the `dexcom_tokens` table in the database, keyed by `userId` (always `1`) and `environment`.

**Step 5 — Redirect**: The user is redirected back to the app with `?dexcom_connected=true&env=<env>` in the URL. The frontend detects this, shows a success toast, and switches to the correct environment tab.

**Token Refresh**: When a tRPC procedure needs an access token, it calls `getValidAccessToken()`. If the stored token expires within 60 seconds, the function automatically refreshes it using the refresh token and updates the database. This is transparent to the user.

**Error Handling**: If the token exchange fails (e.g., "max user count exceeded"), the backend extracts a human-readable error from Dexcom's response (which can come in multiple formats) and redirects with `?dexcom_error=<message>&env=<env>`. The frontend displays this as a toast notification.

---

## 6. Key File Reference

The table below maps each significant file to its responsibility in the application.

| File Path | Responsibility |
|-----------|---------------|
| `server/dexcom.ts` | Core Dexcom service layer — OAuth URL generation, token exchange, token refresh, token storage/retrieval, EGV and data range API calls |
| `server/dexcomRoutes.ts` | Express routes for OAuth flow (`/api/dexcom/authorize`, `/api/dexcom/callback`) |
| `server/routers.ts` | tRPC router definitions — `dexcom.status`, `dexcom.disconnect`, `dexcom.dataRange`, `dexcom.egvs` procedures |
| `server/db.ts` | Lazy Drizzle connection helper (`getDb()`). Returns `null` when `DATABASE_URL` is unset, so local tooling runs without a database |
| `server/_core/index.ts` | Express server entry point — registers tRPC middleware, Dexcom routes, and Vite dev middleware |
| `server/_core/env.ts` | Reads `DEXCOM_CLIENT_ID` and `DEXCOM_CLIENT_SECRET` from the environment |
| `drizzle/schema.ts` | Database table definitions (`users`, `dexcom_tokens`) using Drizzle ORM |
| `shared/const.ts` | Shared constants — Dexcom base URLs, environment types, timezone mode type, Apple Health metric definitions |
| `server/appleHealth.ts` | `pearsonCorrelation()` and the `AggregatedBucket` type. The server-side XML parser that used to live here was removed when parsing moved to the browser |
| `client/src/workers/appleHealthWorker.ts` | Web Worker that reads the Apple Health ZIP, streams `export.xml` through `DecompressionStream`, and aggregates into 15-minute buckets — all client-side |
| `client/src/lib/splitDateRange.ts` | Splits a date range into chunks of at most `maxDays` days for the correlation view's EGV fetches |
| `client/src/pages/Correlations.tsx` | Health Correlations tab — file upload, metric toggles, date range, correlation results |
| `client/src/components/CorrelationChart.tsx` | Recharts ComposedChart overlaying glucose with health metrics and workout reference areas |
| `client/src/pages/Home.tsx` | Main UI — tabbed interface (Connect, EGV Data, Health Correlations, API Info), environment and timezone toggles, date inputs, export buttons |
| `client/src/components/EgvChart.tsx` | Recharts-based glucose timeline chart with target range highlighting and trend tooltips |
| `client/src/components/JsonViewer.tsx` | Syntax-highlighted JSON viewer for raw API responses, with a size cap (§7.6) |
| `client/src/lib/timezone.ts` | Timezone conversion utilities — UTC/local formatting, input-to-API date conversion |
| `client/src/lib/export.ts` | Export utilities — CSV, JSON, and PNG (SVG-to-Canvas) chart export |
| `render.yaml` | Render deployment configuration (Infrastructure as Code) |
| `DEPLOY.md` | Step-by-step deployment guide for Render + TiDB Cloud |

---

## 7. Frontend Features

### 7.1 Environment Toggle

A toggle in the header switches between **Sandbox** and **Production** environments. The application **defaults to Production** on page load. Each environment maintains independent OAuth tokens and connection state. Production mode displays a warning banner reminding users that real patient data is being accessed.

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
| Hover tooltip | Shows exact value, time, trend arrow, and rate of change |
| **Average glucose badge** | Displayed next to the chart title, color-coded: green (80–180), red (<80), amber (>180) |

The chart X-axis uses **smart axis labels** that adapt to the date range being displayed. When the data spans a single day or less, only times are shown (e.g., "02:30 PM"). When the data spans multiple days, the axis switches to a date+time format (e.g., "01/15 14:30") with slightly angled labels to prevent overlap.

### 7.4 Export Options

Three export formats are available once EGV data is loaded:

| Format | Contents | Filename Pattern |
|--------|----------|-----------------|
| **CSV** | All EGV record fields plus a formatted display time column | `dexcom-egvs_<env>_<timestamp>.csv` |
| **JSON** | Raw Dexcom API response with pretty-print indentation | `dexcom-egvs_<env>_<timestamp>.json` |
| **PNG** | Glucose chart with metadata header (date range, average glucose, record count) rendered at 2x resolution via SVG-to-Canvas | `dexcom-chart_<env>_<timestamp>.png` |

The PNG export includes a header above the chart containing: the chart title with timezone label, the average glucose value (color-coded by range), formatted start and end dates, the date range duration (hours or days), the total record count, and the environment label (Production or Sandbox).

### 7.5 Apple Health Correlations

The **Health Correlations** tab allows users to upload an Apple Health export (ZIP file containing `export.xml`) and overlay health metrics with EGV glucose data on a shared timeline.

**Upload Flow**: Users export their health data from the Apple Health app on iPhone (Profile > Export All Health Data), which produces a ZIP file. **Everything is parsed in the browser** — the file is never uploaded. `client/src/workers/appleHealthWorker.ts` runs in a Web Worker, parses the ZIP central directory by hand to locate `export.xml`'s compressed bytes (Apple Health ZIPs use data descriptors, so the local header sizes are unusable), then streams those bytes through the browser's native `DecompressionStream("deflate-raw")` and scans the XML in chunks. Only the relevant metrics are extracted; other record types are skipped.

This design exists because a 100 MB export expands to roughly 2 GB of XML — past V8's maximum string length, and far past what Render's 512 MB instance could hold. Parsing client-side removes the server from the equation entirely, regardless of file size. A real 102 MB export (2.1 GB of XML) parses in about 32 seconds with a ~169 MB peak, yielding ~3.6 M data points across 7 metrics.

Only the aggregated result is sent to the server, in two stages: `appleHealth.saveResults` writes the summary and workouts (~0.5 MB), then `appleHealth.saveBucketBatch` is called repeatedly with 10,000 buckets at a time. A single payload was ~90 MB against a 50 MB body-parser limit, hence the batching.

**Show Correlations Button**: After uploading health data and selecting a date range and metrics, users click the "Show Correlations" button to trigger EGV data fetching and chart rendering. The button provides contextual hints when prerequisites are missing (e.g., "Upload Apple Health data first" or "Connect to Dexcom first"). For date ranges exceeding 7 days, `splitDateRange()` splits the request into 7-day chunks which are fetched sequentially via `trpcUtils.dexcom.egvs.fetch()`. A progress indicator shows "Fetching chunk 2/5..." during multi-chunk loads. If an individual chunk fails it is logged and skipped, unless the failure is an authorization error, which aborts the whole run.

**Supported Metrics**:

| Metric | Apple Health Type | Unit | Chart Style |
|--------|------------------|------|-------------|
| Steps | `HKQuantityTypeIdentifierStepCount` | steps | Bar |
| Heart Rate | `HKQuantityTypeIdentifierHeartRate` | bpm | Line |
| Resting HR | `HKQuantityTypeIdentifierRestingHeartRate` | bpm | Dashed Line |
| HRV (SDNN) | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | ms | Line |
| Active Energy | `HKQuantityTypeIdentifierActiveEnergyBurned` | kcal | Bar |
| Exercise Time | `HKQuantityTypeIdentifierAppleExerciseTime` | min | Bar |
| Distance | `HKQuantityTypeIdentifierDistanceWalkingRunning` | mi | Bar |
| SpO2 | `HKQuantityTypeIdentifierOxygenSaturation` | % | Line |

**Data Aggregation**: Parsed data points are aggregated into 15-minute time buckets. For each bucket, the system computes average, min, max, sum, and count for each metric. Cumulative metrics (steps, energy, exercise time, distance) use the sum value for display; rate metrics (heart rate, HRV) use the average.

**Correlation Analysis**: The system computes Pearson correlation coefficients between glucose values and each health metric over matching 15-minute time buckets. Results are classified by strength (strong: |r| > 0.7, moderate: 0.4–0.7, weak: 0.2–0.4, negligible: < 0.2) and direction (positive or negative). A minimum of 5 overlapping buckets is required for a valid correlation.

**Workout Overlay**: Workouts from the Apple Health export are displayed as shaded reference areas on the chart and listed in a separate card with activity type, duration, and calories burned.

**Storage**: Results are persisted to the database (§4.3), so they survive restarts and redeploys. Importing again replaces the previous import, and "Clear Data" removes it via the `appleHealth.clear` mutation.

### 7.6 Raw Response Viewer

Every API response is shown in a collapsible, syntax-highlighted viewer (`client/src/components/JsonViewer.tsx`).

Highlighting injects roughly one `<span>` per token, so its cost scales with the size of the payload rather than with how much of it is on screen. A 28-day EGV response is around 8,000 records — about 4 MB of pretty-printed JSON, which previously became ~261,000 DOM nodes and blocked the main thread for roughly nine seconds, long enough that the chart below it never got a chance to paint.

The viewer therefore highlights at most 60 KB, snapped to a line boundary, and shows a `Showing first N of M lines` notice. Two escape hatches keep the full payload reachable:

- **Show all (plain text)** renders the entire response unhighlighted. A multi-megabyte payload stays a single text node instead of hundreds of thousands of elements, which costs a few hundred milliseconds rather than seconds.
- **Copy** always copies the complete response, regardless of what is displayed.

Responses under the cap are unaffected — they render fully highlighted with no notice and no toggle.

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
| **Client-side parsing** | Web Worker + `DecompressionStream` | native | ZIP inflate and XML scan for Apple Health imports, off the main thread |
| **Package manager** | pnpm | 10.4 | Fast, disk-efficient package management |

---

## 11. Common Maintenance Tasks

### 11.1 Updating Dexcom Credentials

If your Dexcom Client ID or Secret changes, update the `DEXCOM_CLIENT_ID` and `DEXCOM_CLIENT_SECRET` environment variables in Render's dashboard (Settings > Environment). The service will automatically redeploy.

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

1. Add an auth provider (Auth0, Clerk, email/password — anything). The template's original auth scaffolding was removed, so there is nothing to re-enable; `TrpcContext` currently carries only `req` and `res`, and `auth.me` returns `null` unconditionally.
2. Put the authenticated user back on the tRPC context in `server/_core/context.ts`, and reintroduce a `protectedProcedure` in `server/_core/trpc.ts` for anything that should require a session.
3. Replace the `SINGLE_USER_ID = 1` constant in `server/routers.ts` and `server/dexcomRoutes.ts` with that user's ID.
4. No schema change is needed — `dexcom_tokens.userId` already scopes tokens per user. The `users` table (§4.1) would become live again.

Note that the Apple Health tables (§4.3) are **not** user-scoped and would need a `userId` column to support this.

### 11.5 Monitoring and Logs

Render provides built-in logging. You can view server logs in the Render dashboard under your service's **Logs** tab. Key log prefixes to watch for:

| Log Prefix | Meaning |
|------------|---------|
| `[Dexcom] Callback error:` | OAuth token exchange failed — check the error details |
| `[Dexcom] Failed to refresh token` | Token refresh failed — user may need to re-authenticate |
| `[Database] Failed to connect:` | Database connection issue — verify `DATABASE_URL` |

### 11.6 Cold Starts on Free Tier

Render's free tier spins down the service after 15 minutes of inactivity. The first request after a cold start may take 30–60 seconds. If this is unacceptable, consider upgrading to Render's paid tier ($7/month for the Starter plan) which keeps the service running continuously.

### 11.7 Running Tests

Run the full test suite with:

```bash
pnpm test
```

There are 43 tests across six files:

| File | Tests | Covers |
|------|-------|--------|
| `server/appleHealth.test.ts` | 11 | Pearson correlation, and the `appleHealth` tRPC procedures with no data loaded |
| `client/src/lib/export.test.ts` | 10 | CSV / JSON / PNG export helpers |
| `client/src/lib/splitDateRange.test.ts` | 10 | Date-range chunking |
| `server/dexcom.routers.test.ts` | 9 | `dexcom` tRPC procedure behaviour and date-range validation |
| `server/dexcom.credentials.test.ts` | 2 | Dexcom credentials are configured |
| `server/auth.logout.test.ts` | 1 | Session cookie is cleared on logout |

**Four of these fail without a `.env`**: both `dexcom.credentials` tests assert the `DEXCOM_*` variables are non-empty, and two `dexcom.routers` tests need a live database connection. A clean local run is therefore **39 passed / 4 failed** — treat that as the baseline rather than a regression.

Note that the 15-minute bucketing which actually ships runs in `client/src/workers/appleHealthWorker.ts` and has no test coverage. The server-side implementation that was tested is gone.

### 11.8 Local Development

To run the application locally:

```bash
# Install dependencies
pnpm install

# Set environment variables (create a .env file or export them)
export DATABASE_URL="mysql://..."
export DEXCOM_CLIENT_ID="your_client_id"
export DEXCOM_CLIENT_SECRET="your_client_secret"
# Start the dev server (hot-reloading enabled)
pnpm dev
```

The dev server prefers port 3000 but scans upward for the first free port (`findAvailablePort` in `server/_core/index.ts`), so check the `Server running on ...` line for the actual URL. Remember to add `http://localhost:<port>/api/dexcom/callback` as a redirect URI in your Dexcom developer app settings for local testing.

Without a `DATABASE_URL` the app still boots and the Connect, Health Correlations and API Info tabs render, but `getDb()` returns `null`, so the connection status is always disconnected and the EGV Data tab stays disabled.

---

## 12. References

[1]: https://developer.dexcom.com/docs "Dexcom Developer API Documentation"
[2]: https://tidbcloud.com/docs "TiDB Cloud Documentation"
[3]: https://docs.render.com "Render Documentation"
