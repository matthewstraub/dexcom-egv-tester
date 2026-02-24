import { COOKIE_NAME, type DexcomEnv } from "@shared/const";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  getDexcomConnectionStatus,
  getValidAccessToken,
  fetchEgvData,
  fetchDataRange,
  disconnectDexcom,
} from "./dexcom";

const dexcomEnvSchema = z.enum(["sandbox", "production"]);

/**
 * Single-user mode: all Dexcom tokens are stored under this fixed user ID.
 * No authentication is required — the app is publicly accessible.
 */
const SINGLE_USER_ID = 1;

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(() => null),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  dexcom: router({
    /** Get the current Dexcom connection status for a given environment */
    status: publicProcedure
      .input(z.object({ env: dexcomEnvSchema }).optional())
      .query(async ({ input }) => {
        const env: DexcomEnv = input?.env ?? "sandbox";
        return getDexcomConnectionStatus(SINGLE_USER_ID, env);
      }),

    /** Disconnect from Dexcom (remove stored tokens) for a given environment */
    disconnect: publicProcedure
      .input(z.object({ env: dexcomEnvSchema }).optional())
      .mutation(async ({ input }) => {
        const env: DexcomEnv = input?.env ?? "sandbox";
        await disconnectDexcom(SINGLE_USER_ID, env);
        return { success: true };
      }),

    /** Fetch the available data range for the connected Dexcom user */
    dataRange: publicProcedure
      .input(z.object({ env: dexcomEnvSchema }).optional())
      .query(async ({ input }) => {
        const env: DexcomEnv = input?.env ?? "sandbox";
        const accessToken = await getValidAccessToken(SINGLE_USER_ID, env);
        if (!accessToken) {
          throw new Error("Not connected to Dexcom. Please authorize first.");
        }
        try {
          const data = await fetchDataRange(accessToken, env);
          return data;
        } catch (err: any) {
          throw new Error(
            err?.response?.data?.message || "Failed to fetch data range from Dexcom"
          );
        }
      }),

    /** Fetch EGV data for a given date range */
    egvs: publicProcedure
      .input(
        z.object({
          startDate: z.string(),
          endDate: z.string(),
          env: dexcomEnvSchema.optional(),
        })
      )
      .query(async ({ input }) => {
        const env: DexcomEnv = input.env ?? "sandbox";

        // Validate date range (Dexcom API max 30 days)
        const start = new Date(input.startDate);
        const end = new Date(input.endDate);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          throw new Error("Invalid date format. Please use ISO 8601 format (e.g. 2024-01-15T10:30:00).");
        }
        if (start >= end) {
          throw new Error("startDate must be before endDate.");
        }
        const diffMs = end.getTime() - start.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays > 30) {
          throw new Error(
            `Date range exceeds the Dexcom API maximum of 30 days. Your range is ${diffDays.toFixed(1)} days. Please narrow your query window.`
          );
        }

        const accessToken = await getValidAccessToken(SINGLE_USER_ID, env);
        if (!accessToken) {
          throw new Error("Not connected to Dexcom. Please authorize first.");
        }
        try {
          const data = await fetchEgvData(
            accessToken,
            input.startDate,
            input.endDate,
            env
          );
          return data;
        } catch (err: any) {
          const errData = err?.response?.data;
          const msg = errData?.message || errData?.error_description || "";
          if (msg.toLowerCase().includes("date range") || msg.toLowerCase().includes("invalid")) {
            throw new Error(
              `Dexcom API error: ${msg}. Note: date range must be \u226430 days, and dates must be ISO 8601 UTC timestamps.`
            );
          }
          throw new Error(msg || "Failed to fetch EGV data from Dexcom");
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
