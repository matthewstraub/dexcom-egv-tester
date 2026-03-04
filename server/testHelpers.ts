import type { TrpcContext } from "./_core/context";

/**
 * Create a mock tRPC context for testing public procedures.
 * No authentication is needed since the app uses single-user mode.
 */
export function createMockContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };
}
