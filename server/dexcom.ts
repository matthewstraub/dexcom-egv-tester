import axios from "axios";
import { eq, and } from "drizzle-orm";
import { dexcomTokens } from "../drizzle/schema";
import { getDb } from "./db";
import { ENV } from "./_core/env";
import { DEXCOM_BASE_URLS, type DexcomEnv } from "@shared/const";

/**
 * Get the Dexcom API base URL for a given environment.
 */
export function getDexcomBaseUrl(env: DexcomEnv): string {
  return DEXCOM_BASE_URLS[env];
}

/**
 * Build the Dexcom OAuth2 authorization URL.
 */
export function getDexcomAuthUrl(redirectUri: string, env: DexcomEnv, state?: string): string {
  const base = getDexcomBaseUrl(env);
  const params = new URLSearchParams({
    client_id: ENV.dexcomClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "offline_access",
  });
  if (state) params.set("state", state);
  return `${base}/v3/oauth2/login?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string, env: DexcomEnv) {
  const base = getDexcomBaseUrl(env);
  const response = await axios.post(
    `${base}/v3/oauth2/token`,
    new URLSearchParams({
      client_id: ENV.dexcomClientId,
      client_secret: ENV.dexcomClientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
  return response.data as {
    access_token: string;
    expires_in: number;
    token_type: string;
    refresh_token: string;
  };
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(refreshToken: string, env: DexcomEnv) {
  const base = getDexcomBaseUrl(env);
  const response = await axios.post(
    `${base}/v3/oauth2/token`,
    new URLSearchParams({
      client_id: ENV.dexcomClientId,
      client_secret: ENV.dexcomClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
  return response.data as {
    access_token: string;
    expires_in: number;
    token_type: string;
    refresh_token: string;
  };
}

/**
 * Save or update Dexcom tokens for a user in the database.
 * Tokens are stored per-user per-environment.
 */
export async function saveDexcomTokens(
  userId: number,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  env: DexcomEnv,
  sandboxUser?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  // Check if user already has tokens for this environment
  const existing = await db
    .select()
    .from(dexcomTokens)
    .where(and(eq(dexcomTokens.userId, userId), eq(dexcomTokens.environment, env)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(dexcomTokens)
      .set({ accessToken, refreshToken, expiresAt, sandboxUser })
      .where(and(eq(dexcomTokens.userId, userId), eq(dexcomTokens.environment, env)));
  } else {
    await db.insert(dexcomTokens).values({
      userId,
      accessToken,
      refreshToken,
      expiresAt,
      sandboxUser,
      environment: env,
    });
  }
}

/**
 * Get a valid access token for a user in a specific environment, refreshing if expired.
 */
export async function getValidAccessToken(userId: number, env: DexcomEnv): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(dexcomTokens)
    .where(and(eq(dexcomTokens.userId, userId), eq(dexcomTokens.environment, env)))
    .limit(1);

  if (rows.length === 0) return null;

  const token = rows[0];

  // If token is still valid (with 60s buffer), return it
  if (token.expiresAt.getTime() > Date.now() + 60_000) {
    return token.accessToken;
  }

  // Token expired, refresh it
  try {
    const refreshed = await refreshAccessToken(token.refreshToken, env);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

    await db
      .update(dexcomTokens)
      .set({
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: newExpiresAt,
      })
      .where(and(eq(dexcomTokens.userId, userId), eq(dexcomTokens.environment, env)));

    return refreshed.access_token;
  } catch (err) {
    console.error(`[Dexcom] Failed to refresh token (${env}):`, err);
    return null;
  }
}

/**
 * Get the Dexcom connection status for a user in a specific environment.
 */
export async function getDexcomConnectionStatus(userId: number, env: DexcomEnv) {
  const db = await getDb();
  if (!db) return { connected: false, environment: env };

  const rows = await db
    .select()
    .from(dexcomTokens)
    .where(and(eq(dexcomTokens.userId, userId), eq(dexcomTokens.environment, env)))
    .limit(1);

  if (rows.length === 0) return { connected: false, environment: env };

  const token = rows[0];
  return {
    connected: true,
    environment: env,
    sandboxUser: token.sandboxUser,
    expiresAt: token.expiresAt.getTime(),
    isExpired: token.expiresAt.getTime() < Date.now(),
  };
}

/**
 * Disconnect Dexcom for a user in a specific environment (remove tokens).
 */
export async function disconnectDexcom(userId: number, env: DexcomEnv) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(dexcomTokens).where(
    and(eq(dexcomTokens.userId, userId), eq(dexcomTokens.environment, env))
  );
}

/**
 * Fetch EGV data from the Dexcom API.
 */
export async function fetchEgvData(
  accessToken: string,
  startDate: string,
  endDate: string,
  env: DexcomEnv
) {
  const base = getDexcomBaseUrl(env);
  const response = await axios.get(
    `${base}/v3/users/self/egvs`,
    {
      params: { startDate, endDate },
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  return response.data;
}

/**
 * Fetch data range from the Dexcom API.
 */
export async function fetchDataRange(accessToken: string, env: DexcomEnv) {
  const base = getDexcomBaseUrl(env);
  const response = await axios.get(
    `${base}/v3/users/self/dataRange`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  return response.data;
}
