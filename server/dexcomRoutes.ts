import type { Express, Request, Response } from "express";
import { exchangeCodeForTokens, getDexcomAuthUrl, saveDexcomTokens } from "./dexcom";
import { sdk } from "./_core/sdk";
import type { DexcomEnv } from "@shared/const";

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

/**
 * Register Dexcom OAuth routes on the Express app.
 * These are standard Express routes (not tRPC) because the Dexcom OAuth
 * redirect callback needs to be a plain GET endpoint.
 */
export function registerDexcomRoutes(app: Express) {
  /**
   * GET /api/dexcom/authorize
   * Returns the Dexcom OAuth authorization URL.
   * The frontend will redirect the user to this URL.
   * Accepts ?origin=...&env=sandbox|production
   */
  app.get("/api/dexcom/authorize", async (req: Request, res: Response) => {
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

      const redirectUri = `${origin}/api/dexcom/callback`;
      const state = Buffer.from(JSON.stringify({ origin, env })).toString("base64");
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
   */
  app.get("/api/dexcom/callback", async (req: Request, res: Response) => {
    try {
      const { code, state, error: oauthError } = req.query;

      // Parse origin and env from state early so error redirects go to the right place
      let origin = "";
      let env: DexcomEnv = "sandbox";
      if (state && typeof state === "string") {
        try {
          const parsed = JSON.parse(Buffer.from(state, "base64").toString());
          origin = parsed.origin || "";
          env = parsed.env === "production" ? "production" : "sandbox";
        } catch {
          // fallback
        }
      }

      const redirectBase = origin || `${req.protocol}://${req.get("host")}`;

      if (oauthError) {
        res.redirect(`${redirectBase}/?dexcom_error=${encodeURIComponent(oauthError as string)}&env=${env}`);
        return;
      }

      if (!code || typeof code !== "string") {
        res.redirect(`${redirectBase}/?dexcom_error=missing_code&env=${env}`);
        return;
      }

      // Verify the user is authenticated via Manus session
      let user;
      try {
        user = await sdk.authenticateRequest(req);
      } catch {
        res.redirect(`${redirectBase}/?dexcom_error=not_authenticated&env=${env}`);
        return;
      }

      const redirectUri = origin
        ? `${origin}/api/dexcom/callback`
        : `${req.protocol}://${req.get("host")}/api/dexcom/callback`;

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(code, redirectUri, env);

      // Save tokens to database with environment
      await saveDexcomTokens(
        user.id,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
        env
      );

      // Redirect back to the app with success and env info
      res.redirect(`${redirectBase}/?dexcom_connected=true&env=${env}`);
    } catch (err: any) {
      console.error("[Dexcom] Callback error:", err?.response?.data || err);

      // Parse origin/env from state for the error redirect
      let origin = "";
      let env: DexcomEnv = "sandbox";
      const stateParam = req.query.state;
      if (stateParam && typeof stateParam === "string") {
        try {
          const parsed = JSON.parse(Buffer.from(stateParam, "base64").toString());
          origin = parsed.origin || "";
          env = parsed.env === "production" ? "production" : "sandbox";
        } catch {
          // fallback
        }
      }

      const redirectBase = origin || `${req.protocol}://${req.get("host")}`;
      const errorMsg = extractDexcomError(err);
      res.redirect(`${redirectBase}/?dexcom_error=${encodeURIComponent(errorMsg)}&env=${env}`);
    }
  });
}
