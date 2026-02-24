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
| `JWT_SECRET` | Yes | Any random string for session signing (auto-generated if using render.yaml) |
| `NODE_ENV` | Yes | Set to `production` |
| `PORT` | No | Render sets this automatically |

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

1. Visit your Render URL.
2. You should see the Dexcom EGV Tester interface immediately (no login required).
3. Switch between Sandbox and Production environments using the toggle.
4. Click **Connect to Dexcom Sandbox** to test the OAuth flow.

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

---

## Architecture

```
Browser → Render (Node.js/Express) → Dexcom API
                    ↕
              TiDB Cloud (MySQL)
```

- **Frontend**: React 19 + Tailwind CSS 4 (served as static files by Express)
- **Backend**: Express 4 + tRPC 11 (handles OAuth flow and API proxying)
- **Database**: TiDB Cloud Serverless (stores Dexcom OAuth tokens)
- **Mode**: Single-user (no authentication required, one set of tokens stored globally)
