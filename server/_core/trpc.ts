import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Anyone signed in — the viewer password or the admin password. */
export const viewerProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.role !== "viewer" && ctx.role !== "admin") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  }
  return next();
});

/** Settings and anything that writes or deletes. */
export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin password required" });
  }
  return next();
});
