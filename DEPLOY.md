# Deploying Dexcom EGV Tester on Render + TiDB Cloud

This guide walks through deploying the Dexcom EGV Tester to **Render** (hosting) with **TiDB Cloud** (database).

---

## Prerequisites

- A [Render](https://render.com) account
- A [TiDB Cloud](https://tidbcloud.com) account (free Serverless tier works)
- A [Dexcom Developer](https://developer.dexcom.com) account with an approved app
- Your code pushed to a GitHub repository

---

## Step 1: Set Up TiDB Cloud Database

1. Log into [TiDB Cloud](https://tidbcloud.com) and create a **Serverless** cluster (free tier).
2. Once created, click **Connect** and select **General** connection method.
3. Copy the connection string. It will look like:
   ```
   mysql://username:password@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/test?ssl={"rejectUnauthorized":true}
   ```
4. You may need to URL-encode special characters in the password.
5. Keep this connection string — you'll need it for the `DATABASE_URL` environment variable.

---

## Step 2: Deploy to Render

### Option A: One-Click Deploy (render.yaml)

1. Push your code to GitHub (if not already done).
2. In Render, click **New > Blueprint** and connect your GitHub repo.
3. Render will detect the `render.yaml` file and set up the service automatically.
4. Fill in the environment variables when prompted:
   - `DATABASE_URL` — your TiDB Cloud connection string
   - `DEXCOM_CLIENT_ID` — from your Dexcom developer app
   - `DEXCOM_CLIENT_SECRET` — from your Dexcom developer app
   - `VIEWER_PASSWORD` and `ADMIN_PASSWORD` — choose two different passwords (Step 3)
   - `DEXCOM_SHARE_USERNAME` and `DEXCOM_SHARE_PASSWORD` — optional, for live data; leave them blank to skip it

   Render generates `SESSION_SECRET` itself.
5. Click **Apply** to deploy.

### Option B: Manual Setup

1. In Render, click **New > Web Service** and connect your GitHub repo.
2. Configure the service:
   - **Runtime**: Node
   - **Build Command**: `pnpm install && pnpm build && pnpm db:push`
   - **Start Command**: `pnpm start`
3. Add environment variables (see below).
4. Click **Create Web Service**.

---

## Step 3: Configure Environment Variables

Set these in your Render service's **Environment** tab:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | TiDB Cloud MySQL connection string |
| `DEXCOM_CLIENT_ID` | Yes | Your Dexcom developer app Client ID |
| `DEXCOM_CLIENT_SECRET` | Yes | Your Dexcom developer app Client Secret |
| `VIEWER_PASSWORD` | Yes | Opens the site: the EGV Data tab and the live card |
| `ADMIN_PASSWORD` | Recommended | Also opens Connect and API Info. Use a different password from the viewer one |
| `SESSION_SECRET` | Yes | A long random value that signs session cookies, e.g. `openssl rand -hex 32`. The Blueprint generates one; a manually created service needs it set by hand |
| `DEXCOM_SHARE_USERNAME` | No | The CGM wearer's own Dexcom username, for live data. Only with the wearer's agreement |
| `DEXCOM_SHARE_PASSWORD` | No | Password for that account |
| `NODE_ENV` | Yes | Set to `production` |
| `PORT` | No | Render sets this automatically |

Without `VIEWER_PASSWORD` and `SESSION_SECRET`, the deployed site shows a "not configured" page instead of the app. It fails closed, never open.

### Upgrading an existing deployment to sign-in

Versions before sign-in had no passwords. Before merging a version that has them, add `VIEWER_PASSWORD`, `ADMIN_PASSWORD` and `SESSION_SECRET` to the service's **Environment** tab (plus the two Share variables, if you want live data), then deploy. Depending on how the service was created, new entries in `render.yaml` may not be applied to it, so check the Environment tab rather than assuming. Anyone who used the site before then needs the viewer password.

---

## Step 4: Update Dexcom Redirect URI

Once your Render service is deployed, you'll get a URL like `https://dexcom-egv-tester.onrender.com`.

1. Go to [Dexcom Developer Portal](https://developer.dexcom.com).
2. Open your app settings.
3. Add the redirect URI: `https://dexcom-egv-tester.onrender.com/api/dexcom/callback`
4. Save the changes.

The app will also display the correct redirect URI on the **Connect** tab — you can copy it from there.

---

## Step 5: Verify Deployment

1. Visit your Render URL. You should see the sign-in page, and nothing else.
2. Sign in with the admin password. The full interface should appear, with an **Admin** badge in the header.
3. Switch between Sandbox and Production environments using the toggle.
4. Click **Connect to Dexcom Sandbox** to test the OAuth flow.
5. If the Share variables are set, switch back to Production: a **Current glucose** card should appear above the tabs within a few seconds.
6. Sign out, sign in with the viewer password, and confirm Connect and API Info show **Admin only**.

---

## Troubleshooting

### Database connection fails
- Ensure your TiDB Cloud connection string includes `?ssl={"rejectUnauthorized":true}` for SSL.
- Check that your TiDB cluster is in the **Available** state.
- Verify the `DATABASE_URL` is correctly set in Render's environment variables.

### OAuth callback fails
- Confirm the redirect URI in your Dexcom app settings exactly matches your Render URL + `/api/dexcom/callback`.
- Check Render logs for detailed error messages.

### "Max user count exceeded" on production
- Your Dexcom production app has a user limit. Contact Dexcom developer support to request an increase.

### The site shows "not configured"
- `VIEWER_PASSWORD` or `SESSION_SECRET` is missing. The page lists which; add them in the Environment tab and Render redeploys.

### The live card says Dexcom rejected the Share username or password
- `DEXCOM_SHARE_USERNAME` / `DEXCOM_SHARE_PASSWORD` must be the CGM wearer's own, current Dexcom login. Fix them promptly: the server keeps retrying with growing pauses, and repeated failures can get the account locked. Saving the corrected values redeploys the service, which also clears the pause.

---

## Architecture

```
Browser → Render (Node.js/Express) → Dexcom API, Dexcom Share (optional)
                    ↕
              TiDB Cloud (MySQL)
```

- **Frontend**: React 19 + Tailwind CSS 4 (served as static files by Express)
- **Backend**: Express 4 + tRPC 11 (handles sign-in, the OAuth flow and API proxying)
- **Database**: TiDB Cloud Serverless (Dexcom OAuth tokens and site settings)
- **Access**: Password sign-in with viewer and admin roles; one set of Dexcom tokens stored per environment
