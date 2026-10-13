import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { exchangeCodeForTokens, getDexcomAuthUrl, saveDexcomTokens } from "./dexcom";
import type { DexcomEnv } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { readCookie, safeEqual } from "./_core/session";

/**
 * Single-user mode: all Dexcom tokens are stored under this fixed user ID.
 */
const SINGLE_USER_ID = 1;

/**
 * Extract a human-readable error message from a Dexcom API error response.
 * Dexcom returns errors in various formats:
 *   - { error_description: "..." }
 *   - { errors: [{ code: "...", title: "..." }] }
 *   - { message: "..." }
 */
function extractDexcomError(err: any): string {
  const data = err?.response?.data;
  if (!data) return err?.message || "token_exchange_failed";

  // Format: { error_description: "..." }
  if (data.error_description) return data.error_description;

  // Format: { errors: [{ code: "...", title: "..." }] }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    return data.errors
      .map((e: any) => `${e.title || e.message || "Unknown error"}${e.code ? ` (${e.code})` : ""}`)
      .join("; ");
  }

  // Format: { message: "..." }
  if (data.message) return data.message;

  // Format: { error: "..." }
  if (data.error) return data.error;

  return "token_exchange_failed";
}

/** Short-lived, single-use value binding an OAuth flow to the browser that started it. */
const NONCE_COOKIE = "dexcom_oauth_nonce";
const NONCE_PATH = "/api/dexcom/callback";
const NONCE_MAX_AGE_MS = 10 * 60 * 1000;

type OAuthState = { origin: string; env: DexcomEnv; nonce: string };

function parseState(state: unknown): OAuthState | null {
  if (typeof state !== "string" || !state) return null;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64").toString());
    if (typeof parsed?.origin !== "string" || typeof parsed?.nonce !== "string") return null;
    return {
      origin: parsed.origin,
      env: parsed.env === "production" ? "production" : "sandbox",
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}

/**
 * Register Dexcom OAuth routes on the Express app.
 * These are standard Express routes (not tRPC) because the Dexcom OAuth
 * redirect callback needs to be a plain GET endpoint.
 *
 * Both routes are admin-only: there is one stored Dexcom connection, and
 * whoever completes this flow replaces it. requireSession runs first and
 * leaves the caller's role on res.locals.
 */
export function registerDexcomRoutes(app: Express) {
  /**
   * GET /api/dexcom/authorize
   * Returns the Dexcom OAuth authorization URL.
   * The frontend will redirect the user to this URL.
   * Accepts ?origin=...&env=sandbox|production
   */
  app.get("/api/dexcom/authorize", async (req: Request, res: Response) => {
    if (res.locals.role !== "admin") {
      res.status(403).json({ error: "Admin password required" });
      return;
    }
    try {
      const origin = req.query.origin as string;
      if (!origin) {
        res.status(400).json({ error: "Missing origin parameter" });
        return;
      }

      const env: DexcomEnv = (req.query.env as DexcomEnv) || "sandbox";
      if (env !== "sandbox" && env !== "production") {
        res.status(400).json({ error: "Invalid env parameter. Must be 'sandbox' or 'production'." });
        return;
      }

      // The nonce lives in this browser's cookie and in the state Dexcom echoes
      // back. A callback carrying someone else's state won't match, which stops
      // a crafted link from swapping in another Dexcom account.
      const nonce = crypto.randomBytes(16).toString("hex");
      res.cookie(NONCE_COOKIE, nonce, {
        ...getSessionCookieOptions(req),
        path: NONCE_PATH,
        maxAge: NONCE_MAX_AGE_MS,
      });

      const redirectUri = `${origin}/api/dexcom/callback`;
      const state = Buffer.from(JSON.stringify({ origin, env, nonce })).toString("base64");
      const authUrl = getDexcomAuthUrl(redirectUri, env, state);

      res.json({ authUrl, redirectUri, env });
    } catch (err) {
      console.error("[Dexcom] Error generating auth URL:", err);
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  });

  /**
   * GET /api/dexcom/callback
   * Handles the OAuth callback from Dexcom.
   * Exchanges the authorization code for tokens and stores them.
   *
   * Every redirect here is same-origin and relative, so nothing in the
   * echoed state can send the browser elsewhere.
   */
  app.get("/api/dexcom/callback", async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;
    const parsed = parseState(state);
    const env: DexcomEnv = parsed?.env ?? "sandbox";
    const fail = (message: string) =>
      res.redirect(`/?dexcom_error=${encodeURIComponent(message)}&env=${env}`);

    // Single use: whatever happens next, this nonce is spent.
    const cookieNonce = readCookie(req, NONCE_COOKIE);
    res.clearCookie(NONCE_COOKIE, { ...getSessionCookieOptions(req), path: NONCE_PATH });

    if (res.locals.role !== "admin") {
      fail("Admin sign-in is required to connect Dexcom");
      return;
    }
    if (!parsed || !cookieNonce || !safeEqual(parsed.nonce, cookieNonce)) {
      fail("This sign-in link has expired or wasn't started here. Please connect again.");
      return;
    }
    if (oauthError) {
      fail(String(oauthError));
      return;
    }
    if (!code || typeof code !== "string") {
      fail("missing_code");
      return;
    }

    try {
      const redirectUri = `${parsed.origin}/api/dexcom/callback`;
      const tokens = await exchangeCodeForTokens(code, redirectUri, env);

      // Save tokens to database under the single-user ID
      await saveDexcomTokens(
        SINGLE_USER_ID,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
        env
      );

      res.redirect(`/?dexcom_connected=true&env=${env}`);
    } catch (err: any) {
      console.error("[Dexcom] Callback error:", err?.response?.data || err);
      fail(extractDexcomError(err));
    }
  });
}
