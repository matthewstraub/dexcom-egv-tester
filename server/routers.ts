import { COOKIE_NAME } from "@shared/const";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  getDexcomConnectionStatus,
  getValidAccessToken,
  fetchEgvData,
  fetchDataRange,
  disconnectDexcom,
} from "./dexcom";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  dexcom: router({
    /** Get the current Dexcom connection status */
    status: protectedProcedure.query(async ({ ctx }) => {
      return getDexcomConnectionStatus(ctx.user.id);
    }),

    /** Disconnect from Dexcom (remove stored tokens) */
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      await disconnectDexcom(ctx.user.id);
      return { success: true };
    }),

    /** Fetch the available data range for the connected Dexcom user */
    dataRange: protectedProcedure.query(async ({ ctx }) => {
      const accessToken = await getValidAccessToken(ctx.user.id);
      if (!accessToken) {
        throw new Error("Not connected to Dexcom. Please authorize first.");
      }
      try {
        const data = await fetchDataRange(accessToken);
        return data;
      } catch (err: any) {
        throw new Error(
          err?.response?.data?.message || "Failed to fetch data range from Dexcom"
        );
      }
    }),

    /** Fetch EGV data for a given date range */
    egvs: protectedProcedure
      .input(
        z.object({
          startDate: z.string(),
          endDate: z.string(),
        })
      )
      .query(async ({ ctx, input }) => {
        const accessToken = await getValidAccessToken(ctx.user.id);
        if (!accessToken) {
          throw new Error("Not connected to Dexcom. Please authorize first.");
        }
        try {
          const data = await fetchEgvData(
            accessToken,
            input.startDate,
            input.endDate
          );
          return data;
        } catch (err: any) {
          const errData = err?.response?.data;
          throw new Error(
            errData?.message || errData?.error_description || "Failed to fetch EGV data from Dexcom"
          );
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
