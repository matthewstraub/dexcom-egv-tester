import type { TrpcContext } from "./_core/context";
import type { Role } from "./_core/session";

/**
 * Create a mock tRPC context. `role` is what requireSession would have
 * resolved: null for a signed-out caller, otherwise viewer or admin.
 */
export function createMockContext(role: Role | null = null): TrpcContext {
  return {
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
      cookie: () => {},
      locals: {},
    } as unknown as TrpcContext["res"],
    role,
  };
}

export const createViewerContext = () => createMockContext("viewer");
export const createAdminContext = () => createMockContext("admin");
