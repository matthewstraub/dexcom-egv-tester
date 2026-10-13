import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { Role } from "./session";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  /** Set by requireSession; null only when a request bypasses it (tests). */
  role: Role | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  return {
    req: opts.req,
    res: opts.res,
    role: (opts.res.locals.role as Role | undefined) ?? null,
  };
}
