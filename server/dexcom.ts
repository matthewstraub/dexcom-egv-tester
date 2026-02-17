import axios from "axios";
import { eq, and } from "drizzle-orm";
import { dexcomTokens } from "../drizzle/schema";
import { getDb } from "./db";
import { ENV } from "./_core/env";

const DEXCOM_SANDBOX_BASE = "https://sandbox-api.dexcom.com";

/**
 * Build the Dexcom OAuth2 authorization URL for the sandbox environment.
 */
export function getDexcomAuthUrl(redirectUri: string, state?: string): string {
  const params = new URLSearchParams({
    client_id: ENV.dexcomClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "offline_access",
  });
  if (state) params.set("state", state);
  return `${DEXCOM_SANDBOX_BASE}/v3/oauth2/login?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const response = await axios.post(
    `${DEXCOM_SANDBOX_BASE}/v3/oauth2/token`,
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
export async function refreshAccessToken(refreshToken: string) {
  const response = await axios.post(
    `${DEXCOM_SANDBOX_BASE}/v3/oauth2/token`,
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
 */
export async function saveDexcomTokens(
  userId: number,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  sandboxUser?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  // Check if user already has tokens
  const existing = await db
    .select()
    .from(dexcomTokens)
    .where(eq(dexcomTokens.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(dexcomTokens)
      .set({ accessToken, refreshToken, expiresAt, sandboxUser })
      .where(eq(dexcomTokens.userId, userId));
  } else {
    await db.insert(dexcomTokens).values({
      userId,
      accessToken,
      refreshToken,
      expiresAt,
      sandboxUser,
    });
  }
}

/**
 * Get a valid access token for a user, refreshing if expired.
 */
export async function getValidAccessToken(userId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(dexcomTokens)
    .where(eq(dexcomTokens.userId, userId))
    .limit(1);

  if (rows.length === 0) return null;

  const token = rows[0];

  // If token is still valid (with 60s buffer), return it
  if (token.expiresAt.getTime() > Date.now() + 60_000) {
    return token.accessToken;
  }

  // Token expired, refresh it
  try {
    const refreshed = await refreshAccessToken(token.refreshToken);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

    await db
      .update(dexcomTokens)
      .set({
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: newExpiresAt,
      })
      .where(eq(dexcomTokens.userId, userId));

    return refreshed.access_token;
  } catch (err) {
    console.error("[Dexcom] Failed to refresh token:", err);
    return null;
  }
}

/**
 * Get the Dexcom connection status for a user.
 */
export async function getDexcomConnectionStatus(userId: number) {
  const db = await getDb();
  if (!db) return { connected: false };

  const rows = await db
    .select()
    .from(dexcomTokens)
    .where(eq(dexcomTokens.userId, userId))
    .limit(1);

  if (rows.length === 0) return { connected: false };

  const token = rows[0];
  return {
    connected: true,
    sandboxUser: token.sandboxUser,
    expiresAt: token.expiresAt.getTime(),
    isExpired: token.expiresAt.getTime() < Date.now(),
  };
}

/**
 * Disconnect Dexcom for a user (remove tokens).
 */
export async function disconnectDexcom(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(dexcomTokens).where(eq(dexcomTokens.userId, userId));
}

/**
 * Fetch EGV data from the Dexcom API.
 */
export async function fetchEgvData(
  accessToken: string,
  startDate: string,
  endDate: string
) {
  const response = await axios.get(
    `${DEXCOM_SANDBOX_BASE}/v3/users/self/egvs`,
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
export async function fetchDataRange(accessToken: string) {
  const response = await axios.get(
    `${DEXCOM_SANDBOX_BASE}/v3/users/self/dataRange`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  return response.data;
}
