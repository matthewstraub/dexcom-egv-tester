import type { Express, Request, Response } from "express";
import { exchangeCodeForTokens, getDexcomAuthUrl, saveDexcomTokens } from "./dexcom";
import { sdk } from "./_core/sdk";

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
   */
  app.get("/api/dexcom/authorize", async (req: Request, res: Response) => {
    try {
      const origin = req.query.origin as string;
      if (!origin) {
        res.status(400).json({ error: "Missing origin parameter" });
        return;
      }

      const redirectUri = `${origin}/api/dexcom/callback`;
      const state = Buffer.from(JSON.stringify({ origin })).toString("base64");
      const authUrl = getDexcomAuthUrl(redirectUri, state);

      res.json({ authUrl, redirectUri });
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

      if (oauthError) {
        res.redirect(`/?dexcom_error=${encodeURIComponent(oauthError as string)}`);
        return;
      }

      if (!code || typeof code !== "string") {
        res.redirect("/?dexcom_error=missing_code");
        return;
      }

      // Verify the user is authenticated via Manus session
      let user;
      try {
        user = await sdk.authenticateRequest(req);
      } catch {
        res.redirect("/?dexcom_error=not_authenticated");
        return;
      }

      // Parse origin from state
      let origin = "";
      if (state && typeof state === "string") {
        try {
          const parsed = JSON.parse(Buffer.from(state, "base64").toString());
          origin = parsed.origin || "";
        } catch {
          // fallback
        }
      }

      const redirectUri = origin
        ? `${origin}/api/dexcom/callback`
        : `${req.protocol}://${req.get("host")}/api/dexcom/callback`;

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(code, redirectUri);

      // Save tokens to database
      await saveDexcomTokens(
        user.id,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in
      );

      // Redirect back to the app with success
      const redirectTo = origin || `${req.protocol}://${req.get("host")}`;
      res.redirect(`${redirectTo}/?dexcom_connected=true`);
    } catch (err: any) {
      console.error("[Dexcom] Callback error:", err?.response?.data || err);
      const errorMsg = err?.response?.data?.error_description || "token_exchange_failed";
      res.redirect(`/?dexcom_error=${encodeURIComponent(errorMsg)}`);
    }
  });
}
