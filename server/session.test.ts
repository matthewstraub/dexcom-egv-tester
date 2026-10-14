import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { COOKIE_NAME } from "@shared/const";
import {
  ADMIN_MAX_AGE_MS,
  VIEWER_MAX_AGE_MS,
  createLoginLimiter,
  createSessionToken,
  getRoleForRequest,
  handleSignIn,
  readCookie,
  requireSession,
  resolveAuthState,
  roleForPassword,
  safeNextPath,
  verifySessionToken,
  type AuthState,
} from "./_core/session";

// Throwaway values for these tests only.
const VIEWER = "viewer-test-password";
const ADMIN = "admin-test-password";
const SECRET = "test-session-secret-0123456789abcdef";

afterEach(() => vi.unstubAllEnvs());

function enforce({ admin = true } = {}) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VIEWER_PASSWORD", VIEWER);
  vi.stubEnv("ADMIN_PASSWORD", admin ? ADMIN : "");
  vi.stubEnv("SESSION_SECRET", SECRET);
}

function mockReq(over: Partial<Request> & { cookie?: string } = {}): Request {
  const { cookie, ...rest } = over;
  return {
    path: "/",
    originalUrl: "/",
    query: {},
    body: {},
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: "203.0.113.7" },
    protocol: "https",
    ...rest,
  } as unknown as Request;
}

function mockRes() {
  const res: any = {
    locals: {},
    statusCode: 200,
    headers: {} as Record<string, string>,
    cookies: [] as Array<{ name: string; value: string; options: any }>,
    redirectedTo: null as null | { status: number; url: string },
    body: undefined as unknown,
  };
  res.status = (code: number) => ((res.statusCode = code), res);
  res.type = () => res;
  res.set = (k: string, v: string) => ((res.headers[k] = v), res);
  res.send = (b: unknown) => ((res.body = b), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.cookie = (name: string, value: string, options: any) => (res.cookies.push({ name, value, options }), res);
  res.redirect = (status: number, url: string) => ((res.redirectedTo = { status, url }), res);
  return res as Response & typeof res;
}

describe("resolveAuthState", () => {
  it("is open in development when VIEWER_PASSWORD is unset", () => {
    expect(resolveAuthState({ NODE_ENV: "development" })).toEqual({ mode: "open" });
  });

  it("fails closed in production and names what is missing", () => {
    expect(resolveAuthState({ NODE_ENV: "production" })).toEqual({
      mode: "misconfigured",
      missing: ["VIEWER_PASSWORD", "SESSION_SECRET"],
    });
    expect(resolveAuthState({ NODE_ENV: "production", VIEWER_PASSWORD: VIEWER })).toEqual({
      mode: "misconfigured",
      missing: ["SESSION_SECRET"],
    });
  });

  it("enforces sign-in when configured, with admin tied to ADMIN_PASSWORD", () => {
    const withAdmin = resolveAuthState({
      NODE_ENV: "production",
      VIEWER_PASSWORD: VIEWER,
      ADMIN_PASSWORD: ADMIN,
      SESSION_SECRET: SECRET,
    });
    expect(withAdmin.mode).toBe("enforced");
    expect(withAdmin.mode === "enforced" && withAdmin.adminEnabled).toBe(true);

    const noAdmin = resolveAuthState({ NODE_ENV: "production", VIEWER_PASSWORD: VIEWER, SESSION_SECRET: SECRET });
    expect(noAdmin.mode === "enforced" && noAdmin.adminEnabled).toBe(false);
  });

  it("generates a stable secret in development when SESSION_SECRET is unset", () => {
    const a = resolveAuthState({ NODE_ENV: "development", VIEWER_PASSWORD: VIEWER });
    const b = resolveAuthState({ NODE_ENV: "development", VIEWER_PASSWORD: VIEWER });
    expect(a.mode === "enforced" && a.config.sessionSecret.length).toBeGreaterThan(30);
    expect(a.mode === "enforced" && b.mode === "enforced" && a.config.sessionSecret === b.config.sessionSecret).toBe(true);
  });
});

describe("roleForPassword", () => {
  const config = { viewerPassword: VIEWER, adminPassword: ADMIN, sessionSecret: SECRET };

  it("grants the role belonging to whichever password matches", () => {
    expect(roleForPassword(ADMIN, config)).toBe("admin");
    expect(roleForPassword(VIEWER, config)).toBe("viewer");
  });

  it("rejects wrong, empty and near-miss passwords", () => {
    expect(roleForPassword("nope", config)).toBeNull();
    expect(roleForPassword("", config)).toBeNull();
    expect(roleForPassword(`${VIEWER} `, config)).toBeNull();
    expect(roleForPassword(VIEWER.toUpperCase(), config)).toBeNull();
  });

  it("never grants admin when no admin password is configured", () => {
    const noAdmin = { ...config, adminPassword: "" };
    expect(roleForPassword("", noAdmin)).toBeNull();
    expect(roleForPassword(VIEWER, noAdmin)).toBe("viewer");
  });
});

describe("session tokens", () => {
  const now = Date.UTC(2026, 9, 12, 20, 0, 0);

  it("round-trips the role", () => {
    expect(verifySessionToken(createSessionToken("viewer", SECRET, now), SECRET, now)).toBe("viewer");
    expect(verifySessionToken(createSessionToken("admin", SECRET, now), SECRET, now)).toBe("admin");
  });

  it("rejects a token whose role was edited", () => {
    const token = createSessionToken("viewer", SECRET, now);
    expect(verifySessionToken(token.replace(".viewer.", ".admin."), SECRET, now)).toBeNull();
  });

  it("rejects a forged signature or a different secret", () => {
    const token = createSessionToken("admin", SECRET, now);
    expect(verifySessionToken(`${token.slice(0, -2)}xx`, SECRET, now)).toBeNull();
    expect(verifySessionToken(token, "some-other-secret", now)).toBeNull();
  });

  it("expires viewer sessions after 90 days and admin sessions after 30", () => {
    const day = 24 * 60 * 60 * 1000;
    const viewer = createSessionToken("viewer", SECRET, now);
    const admin = createSessionToken("admin", SECRET, now);
    expect(verifySessionToken(viewer, SECRET, now + VIEWER_MAX_AGE_MS - day)).toBe("viewer");
    expect(verifySessionToken(viewer, SECRET, now + VIEWER_MAX_AGE_MS + day)).toBeNull();
    expect(verifySessionToken(admin, SECRET, now + ADMIN_MAX_AGE_MS - day)).toBe("admin");
    expect(verifySessionToken(admin, SECRET, now + ADMIN_MAX_AGE_MS + day)).toBeNull();
  });

  it("rejects tokens issued in the future and malformed input", () => {
    expect(verifySessionToken(createSessionToken("viewer", SECRET, now + 5 * 60_000), SECRET, now)).toBeNull();
    for (const bad of [undefined, "", "a.b.c", "v1.viewer.123", "v2.viewer.1.sig", "v1.root.1.sig"]) {
      expect(verifySessionToken(bad, SECRET, now)).toBeNull();
    }
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/?tab=data")).toBe("/?tab=data");
    expect(safeNextPath("/api/dexcom/callback?code=x")).toBe("/api/dexcom/callback?code=x");
  });

  it("refuses anything that could leave the site, or loop back to sign-in", () => {
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "evil", "", undefined, 42, "/login", "/login?next=/"]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });
});

describe("login limiter", () => {
  it("locks an address after the failure budget and recovers after the window", () => {
    const limiter = createLoginLimiter({ maxFailures: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) limiter.recordFailure("ip", 0);
    expect(limiter.isLimited("ip", 10)).toBe(true);
    expect(limiter.isLimited("other-ip", 10)).toBe(false);
    expect(limiter.isLimited("ip", 1001)).toBe(false);
  });

  it("clears an address on success", () => {
    const limiter = createLoginLimiter({ maxFailures: 1 });
    limiter.recordFailure("ip");
    limiter.reset("ip");
    expect(limiter.isLimited("ip")).toBe(false);
  });
});

describe("readCookie", () => {
  it("finds one cookie among several and decodes it", () => {
    const req = mockReq({ cookie: `a=1; ${COOKIE_NAME}=v1.viewer.1%2Fx; b=2` });
    expect(readCookie(req, COOKIE_NAME)).toBe("v1.viewer.1/x");
    expect(readCookie(req, "missing")).toBeUndefined();
  });
});

describe("getRoleForRequest", () => {
  it("downgrades an admin cookie once ADMIN_PASSWORD is removed", () => {
    const token = createSessionToken("admin", SECRET);
    const state: AuthState = {
      mode: "enforced",
      config: { viewerPassword: VIEWER, adminPassword: "", sessionSecret: SECRET },
      adminEnabled: false,
    };
    expect(getRoleForRequest(mockReq({ cookie: `${COOKIE_NAME}=${token}` }), state)).toBe("viewer");
  });
});

describe("requireSession", () => {
  it("lets everyone through as admin when sign-in is off (development)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VIEWER_PASSWORD", "");
    const res = mockRes();
    const next = vi.fn();
    requireSession(mockReq(), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.role).toBe("admin");
  });

  it("locks the whole site with 503 when production is misconfigured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VIEWER_PASSWORD", "");
    vi.stubEnv("SESSION_SECRET", "");
    const page = mockRes();
    const next = vi.fn();
    requireSession(mockReq({ path: "/" }), page, next);
    expect(next).not.toHaveBeenCalled();
    expect(page.statusCode).toBe(503);
    expect(String(page.body)).toContain("VIEWER_PASSWORD");

    const api = mockRes();
    requireSession(mockReq({ path: "/api/trpc/dexcom.egvs" }), api, next);
    expect(api.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers signed-out API calls with 401 and redirects pages to sign-in", () => {
    enforce();
    const next = vi.fn();

    const api = mockRes();
    requireSession(mockReq({ path: "/api/trpc/dexcom.egvs", originalUrl: "/api/trpc/dexcom.egvs" }), api, next);
    expect(api.statusCode).toBe(401);

    const page = mockRes();
    requireSession(mockReq({ path: "/", originalUrl: "/?tab=data" }), page, next);
    expect(page.redirectedTo).toEqual({ status: 302, url: "/login?next=%2F%3Ftab%3Ddata" });

    // The OAuth callback is a browser navigation, so it redirects rather than 401s.
    const callback = mockRes();
    requireSession(mockReq({ path: "/api/dexcom/callback", originalUrl: "/api/dexcom/callback?code=x" }), callback, next);
    expect(callback.redirectedTo?.url).toMatch(/^\/login\?next=/);

    expect(next).not.toHaveBeenCalled();
  });

  it("passes a valid session through with its role", () => {
    enforce();
    const res = mockRes();
    const next = vi.fn();
    requireSession(mockReq({ cookie: `${COOKIE_NAME}=${createSessionToken("viewer", SECRET)}` }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.role).toBe("viewer");
  });
});

describe("handleSignIn", () => {
  const signIn = (
    body: Record<string, string>,
    limiter = createLoginLimiter(),
    overall = createLoginLimiter({ maxFailures: 1000 }),
    from?: string
  ) => {
    const res = mockRes();
    const headers = from ? { "x-forwarded-for": from } : {};
    handleSignIn(mockReq({ body, headers } as Partial<Request>), res, limiter, overall);
    return res;
  };

  it("sets a viewer cookie for the viewer password and follows next", () => {
    enforce();
    const res = signIn({ password: VIEWER, next: "/?tab=data" });
    expect(res.redirectedTo).toEqual({ status: 303, url: "/?tab=data" });
    expect(res.cookies).toHaveLength(1);
    const { name, value, options } = res.cookies[0]!;
    expect(name).toBe(COOKIE_NAME);
    expect(verifySessionToken(value, SECRET)).toBe("viewer");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, maxAge: VIEWER_MAX_AGE_MS });
  });

  it("sets an admin cookie for the admin password", () => {
    enforce();
    const res = signIn({ password: ADMIN });
    expect(verifySessionToken(res.cookies[0]!.value, SECRET)).toBe("admin");
    expect(res.cookies[0]!.options.maxAge).toBe(ADMIN_MAX_AGE_MS);
  });

  it("rejects a wrong password without setting a cookie", () => {
    enforce();
    const res = signIn({ password: "wrong" });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
    expect(String(res.body)).toContain("Incorrect password");
  });

  it("treats the viewer password on the admin form as a failure", () => {
    enforce();
    const res = signIn({ password: VIEWER, want: "admin" });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
    expect(String(res.body)).toContain("admin password");
  });

  it("never redirects off-site, whatever next says", () => {
    enforce();
    expect(signIn({ password: VIEWER, next: "//evil.example" }).redirectedTo?.url).toBe("/");
  });

  it("refuses further attempts once an address is rate-limited", () => {
    enforce();
    const limiter = createLoginLimiter({ maxFailures: 2 });
    signIn({ password: "wrong" }, limiter);
    signIn({ password: "wrong" }, limiter);
    const res = signIn({ password: VIEWER }, limiter);
    expect(res.statusCode).toBe(429);
    expect(res.cookies).toHaveLength(0);
  });

  it("caps failures overall, so a forged X-Forwarded-For can't dodge the limit", () => {
    enforce();
    const perAddress = createLoginLimiter({ maxFailures: 2 });
    const overall = createLoginLimiter({ maxFailures: 5 });
    // A fresh made-up address on every guess never trips the per-address limit...
    for (let i = 0; i < 5; i++) {
      expect(signIn({ password: "wrong" }, perAddress, overall, `198.51.100.${i}`).statusCode).toBe(401);
    }
    // ...but the overall cap holds, even for the right password from a new address.
    const res = signIn({ password: VIEWER }, perAddress, overall, "198.51.100.99");
    expect(res.statusCode).toBe(429);
    expect(res.cookies).toHaveLength(0);
  });

  it("doesn't let a successful sign-in reset the overall count", () => {
    enforce();
    const overall = createLoginLimiter({ maxFailures: 3 });
    signIn({ password: "wrong" }, undefined, overall, "198.51.100.1");
    signIn({ password: "wrong" }, undefined, overall, "198.51.100.2");
    expect(signIn({ password: VIEWER }, undefined, overall, "203.0.113.50").cookies).toHaveLength(1);
    signIn({ password: "wrong" }, undefined, overall, "198.51.100.3");
    expect(signIn({ password: VIEWER }, undefined, overall, "203.0.113.50").statusCode).toBe(429);
  });

  it("escapes next when re-rendering the form", () => {
    enforce();
    const res = signIn({ password: "wrong", next: '/"><script>alert(1)</script>' });
    expect(String(res.body)).not.toContain("<script>alert(1)</script>");
  });
});
