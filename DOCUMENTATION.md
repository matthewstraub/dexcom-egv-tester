# Dexcom EGV Tester — Technical Documentation

**Version**: 1.0  
**Last Updated**: February 24, 2026  
**Author**: Manus AI

---

## 1. Overview

The Dexcom EGV Tester is a full-stack web application designed to authenticate with the Dexcom CGM (Continuous Glucose Monitor) API via OAuth2 and retrieve Estimated Glucose Values (EGVs). It provides a developer-focused interface for testing both the Dexcom Sandbox and Production API environments, visualizing glucose data on an interactive timeline chart, and exporting results in multiple formats.

The application runs in **single-user mode** — no login or account creation is required. Anyone who visits the app can connect to Dexcom, fetch data, and export results. A single set of OAuth tokens is stored per environment (Sandbox and Production), meaning the last person to authenticate "owns" the active connection.

---

## 2. Architecture

The application follows a standard three-tier architecture with a React frontend, a Node.js/Express backend, and a MySQL-compatible database.

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Client)                     │
│  React 19 + Tailwind CSS 4 + Recharts + tRPC Client     │
└──────────────────────┬──────────────────────────────────┘
                       │  HTTP (tRPC over /api/trpc)
                       │  Express routes (/api/dexcom/*)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  Node.js Server (Backend)                 │
│  Express 4 + tRPC 11 + Axios + Drizzle ORM              │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ tRPC Router │  │ Dexcom OAuth │  │ Dexcom API     │  │
│  │ (procedures)│  │ (Express)    │  │ (proxy calls)  │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │           │
│         ▼                ▼                   ▼           │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Dexcom Service Layer (dexcom.ts)        │   │
│  │  Token management, API calls, token refresh       │   │
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

The database contains two tables managed by Drizzle ORM. Migrations are applied via `pnpm db:push` (which runs `drizzle-kit generate && drizzle-kit migrate`).

### 4.1 `users` Table

This table exists as part of the template scaffolding. In single-user mode, it contains a single row with `id = 1` that serves as the foreign key anchor for token storage.

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
| `server/db.ts` | Database connection helper (lazy initialization) and user upsert/query functions |
| `server/_core/index.ts` | Express server entry point — registers tRPC middleware, Dexcom routes, and Vite dev middleware |
| `server/_core/env.ts` | Environment variable parsing and validation |
| `drizzle/schema.ts` | Database table definitions (`users`, `dexcom_tokens`) using Drizzle ORM |
| `shared/const.ts` | Shared constants — Dexcom base URLs, environment types, timezone mode type |
| `client/src/pages/Home.tsx` | Main UI — tabbed interface (Connect, EGV Data, API Info), environment toggle, date inputs, data table |
| `client/src/components/EgvChart.tsx` | Recharts-based glucose timeline chart with target range highlighting and trend tooltips |
| `client/src/components/JsonViewer.tsx` | Syntax-highlighted JSON viewer for raw API responses |
| `client/src/lib/timezone.ts` | Timezone conversion utilities — UTC/local formatting, input-to-API date conversion |
| `client/src/lib/export.ts` | Export utilities — CSV, JSON, and PNG (SVG-to-Canvas) chart export |
| `render.yaml` | Render deployment configuration (Infrastructure as Code) |
| `DEPLOY.md` | Step-by-step deployment guide for Render + TiDB Cloud |

---

## 7. Frontend Features

### 7.1 Environment Toggle

A toggle in the header switches between **Sandbox** and **Production** environments. Each environment maintains independent OAuth tokens and connection state. Production mode displays a warning banner reminding users that real patient data is being accessed.

### 7.2 Timezone Selector

A UTC/Local toggle in the header controls how all dates and times are displayed throughout the application. In UTC mode, all timestamps are shown in ISO 8601 UTC format. In Local mode, timestamps are converted to the user's browser timezone (e.g., EST). The date input fields, chart X-axis labels, chart tooltips, and data table all respect this setting. Regardless of display mode, all dates are converted to UTC before being sent to the Dexcom API.

### 7.3 EGV Data Visualization

The glucose chart uses Recharts to render an interactive timeline with the following visual elements:

| Element | Description |
|---------|-------------|
| Green shaded area (70–180 mg/dL) | Target glucose range |
| Amber dashed lines (70, 180) | Low and high thresholds |
| Red dashed line (54) | Urgent low threshold |
| Teal line | Glucose readings over time |
| Hover tooltip | Shows exact value, time, trend arrow, and rate of change |

### 7.4 Export Options

Three export formats are available once EGV data is loaded:

| Format | Contents | Filename Pattern |
|--------|----------|-----------------|
| **CSV** | All EGV record fields plus a formatted display time column | `dexcom-egvs_<env>_<timestamp>.csv` |
| **JSON** | Raw Dexcom API response with pretty-print indentation | `dexcom-egvs_<env>_<timestamp>.json` |
| **PNG** | Glucose chart rendered at 2x resolution via SVG-to-Canvas | `dexcom-chart_<env>_<timestamp>.png` |

---

## 8. Environment Variables

The application requires the following environment variables in production. These are configured in Render's Environment settings.

| Variable | Required | Description | Where to Obtain |
|----------|----------|-------------|-----------------|
| `DATABASE_URL` | Yes | MySQL connection string with TLS | TiDB Cloud dashboard > Connect > Connection String |
| `DEXCOM_CLIENT_ID` | Yes | Dexcom developer app Client ID | [Dexcom Developer Portal](https://developer.dexcom.com) > My Apps |
| `DEXCOM_CLIENT_SECRET` | Yes | Dexcom developer app Client Secret | [Dexcom Developer Portal](https://developer.dexcom.com) > My Apps |
| `JWT_SECRET` | Yes | Random string for session cookie signing | Auto-generated by `render.yaml`, or set any random string |
| `NODE_ENV` | Yes | Must be `production` for deployed builds | Set to `production` in Render |
| `PORT` | No | Server port (Render sets this automatically) | Managed by Render |

---

## 9. Dexcom Redirect URI Configuration

The Dexcom OAuth flow requires a **Redirect URI** registered in your Dexcom developer app settings. This URI must exactly match the callback URL the application uses.

| Hosting Environment | Redirect URI |
|--------------------|--------------|
| Render (production) | `https://dexcom-egv-tester.onrender.com/api/dexcom/callback` |
| Manus (development) | `https://<manus-preview-url>/api/dexcom/callback` |
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

1. Re-enable authentication (add an auth provider like Auth0, Clerk, or email/password).
2. Replace the `SINGLE_USER_ID = 1` constant in `server/routers.ts` and `server/dexcomRoutes.ts` with the authenticated user's ID from the session.
3. The database schema already supports per-user tokens via the `userId` column, so no schema changes are needed.

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

Tests are located in `server/dexcom.routers.test.ts`, `server/dexcom.credentials.test.ts`, `server/auth.logout.test.ts`, and `client/src/lib/export.test.ts`. They validate date range logic, tRPC procedure behavior, credential configuration, and export utilities.

### 11.8 Local Development

To run the application locally:

```bash
# Install dependencies
pnpm install

# Set environment variables (create a .env file or export them)
export DATABASE_URL="mysql://..."
export DEXCOM_CLIENT_ID="your_client_id"
export DEXCOM_CLIENT_SECRET="your_client_secret"
export JWT_SECRET="any_random_string"

# Start the dev server (hot-reloading enabled)
pnpm dev
```

The dev server runs on `http://localhost:3000`. Remember to add `http://localhost:3000/api/dexcom/callback` as a redirect URI in your Dexcom developer app settings for local testing.

---

## 12. References

[1]: https://developer.dexcom.com/docs "Dexcom Developer API Documentation"
[2]: https://tidbcloud.com/docs "TiDB Cloud Documentation"
[3]: https://docs.render.com "Render Documentation"
