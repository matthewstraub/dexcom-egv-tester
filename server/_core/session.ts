import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./cookies";

/**
 * Site-wide sign-in with two roles.
 *
 * One password box, two passwords: VIEWER_PASSWORD opens the EGV page, and
 * ADMIN_PASSWORD additionally opens the settings tabs. Whichever password
 * matches decides the role. Sessions are an HMAC-signed cookie keyed by a
 * separate random SESSION_SECRET — deliberately not derived from either
 * password, so a cookie that leaks says nothing about the passwords.
 *
 * In production a missing VIEWER_PASSWORD or SESSION_SECRET fails closed: the
 * site refuses every request rather than silently serving health data to
 * anyone. In development an unset VIEWER_PASSWORD leaves the site open, so
 * local work needs no setup.
 */

export type Role = "viewer" | "admin";

export const VIEWER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const ADMIN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = "v1";

export interface AuthConfig {
  viewerPassword: string;
  adminPassword: string;
  sessionSecret: string;
}

export type AuthState =
  | { mode: "open" }
  | { mode: "misconfigured"; missing: string[] }
  | { mode: "enforced"; config: AuthConfig; adminEnabled: boolean };

// A dev server with VIEWER_PASSWORD set but no SESSION_SECRET still needs a
// key; sessions just won't survive a restart. Production never takes this path.
let devFallbackSecret: string | null = null;

export function resolveAuthState(env: NodeJS.ProcessEnv = process.env): AuthState {
  const viewerPassword = env.VIEWER_PASSWORD ?? "";
  const adminPassword = env.ADMIN_PASSWORD ?? "";
  let sessionSecret = env.SESSION_SECRET ?? "";

  if (env.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!viewerPassword) missing.push("VIEWER_PASSWORD");
    if (!sessionSecret) missing.push("SESSION_SECRET");
    if (missing.length > 0) return { mode: "misconfigured", missing };
  } else {
    if (!viewerPassword) return { mode: "open" };
    if (!sessionSecret) {
      devFallbackSecret ??= crypto.randomBytes(32).toString("hex");
      sessionSecret = devFallbackSecret;
    }
  }

  return {
    mode: "enforced",
    config: { viewerPassword, adminPassword, sessionSecret },
    adminEnabled: adminPassword.length > 0,
  };
}

// ── Passwords ──

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string comparison that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/**
 * The role a password grants, or null. Both comparisons always run, so the
 * response time doesn't reveal which password matched.
 */
export function roleForPassword(password: string, config: AuthConfig): Role | null {
  const matchesAdmin = safeEqual(password, config.adminPassword);
  const matchesViewer = safeEqual(password, config.viewerPassword);
  if (password && config.adminPassword && matchesAdmin) return "admin";
  if (password && config.viewerPassword && matchesViewer) return "viewer";
  return null;
}

// ── Session tokens ──

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(role: Role, secret: string, now = Date.now()): string {
  const payload = `${TOKEN_VERSION}.${role}.${now}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now()
): Role | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, role, issuedAtRaw, mac] = parts as [string, string, string, string];
  if (version !== TOKEN_VERSION) return null;
  if (role !== "viewer" && role !== "admin") return null;

  const expected = Buffer.from(sign(`${version}.${role}.${issuedAtRaw}`, secret));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return null;
  const maxAge = role === "admin" ? ADMIN_MAX_AGE_MS : VIEWER_MAX_AGE_MS;
  // Reject tokens from the future too (beyond a minute of clock skew).
  if (now - issuedAt > maxAge || issuedAt - now > 60_000) return null;
  return role;
}

// ── Request helpers ──

/** Read one cookie by hand; the `cookie` package was removed in #4. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function getRoleForRequest(req: Request, state: AuthState = resolveAuthState()): Role | null {
  if (state.mode === "open") return "admin";
  if (state.mode === "misconfigured") return null;
  const role = verifySessionToken(readCookie(req, COOKIE_NAME), state.config.sessionSecret);
  // An admin cookie must not outlive the admin password being removed.
  if (role === "admin" && !state.adminEnabled) return "viewer";
  return role;
}

/** Only same-site absolute paths survive; anything else becomes "/". */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || next.length === 0) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login/")) return "/";
  return next;
}

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

// ── Brute-force limiter ──

export function createLoginLimiter({ maxFailures = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map<string, { count: number; firstAt: number }>();
  const live = (key: string, now: number) => {
    const entry = failures.get(key);
    if (entry && now - entry.firstAt > windowMs) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    isLimited(key: string, now = Date.now()) {
      return (live(key, now)?.count ?? 0) >= maxFailures;
    },
    recordFailure(key: string, now = Date.now()) {
      const entry = live(key, now);
      if (entry) entry.count++;
      else failures.set(key, { count: 1, firstAt: now });
    },
    reset(key: string) {
      failures.delete(key);
    },
  };
}

/**
 * Two limits on failed sign-ins. Per address, the address comes from
 * X-Forwarded-For behind Render's proxy, and a client can add its own entries
 * to that header, so this limit is only best effort. The overall limit is the
 * backstop no header can dodge: it caps guesses for everyone at once. Hitting
 * it pauses new sign-ins only; existing sessions carry on.
 */
const loginLimiter = createLoginLimiter();
const overallLoginLimiter = createLoginLimiter({ maxFailures: 30 });
const OVERALL = "*";

// ── Pages ──

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: oklch(0.16 0.014 264); color: oklch(0.88 0.01 264);
    font: 15px/1.5 "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: 100%; max-width: 380px; padding: 28px;
    background: oklch(0.19 0.016 264); border: 1px solid oklch(0.28 0.02 264); border-radius: 12px;
  }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  p { margin: 0 0 20px; font-size: 13px; color: oklch(0.58 0.02 264); }
  label { display: block; margin-bottom: 6px; font-size: 12px; color: oklch(0.58 0.02 264);
    font-family: "Fira Code", ui-monospace, monospace; }
  input[type=password] {
    width: 100%; padding: 10px 12px; font-size: 15px; color: inherit;
    background: oklch(0.25 0.018 264); border: 1px solid oklch(0.28 0.02 264); border-radius: 8px;
  }
  input[type=password]:focus { outline: 2px solid oklch(0.72 0.15 180); outline-offset: 1px; }
  button {
    width: 100%; margin-top: 16px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer;
    color: oklch(0.16 0.014 264); background: oklch(0.72 0.15 180); border: 0; border-radius: 8px;
  }
  .error { margin: 0 0 16px; padding: 8px 12px; font-size: 13px; border-radius: 8px;
    color: oklch(0.65 0.2 25); background: oklch(0.65 0.2 25 / 0.1);
    border: 1px solid oklch(0.65 0.2 25 / 0.3); }
  code { font-family: "Fira Code", ui-monospace, monospace; font-size: 12px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderSignInPage({
  next,
  error,
  wantAdmin = false,
}: {
  next: string;
  error?: string | null;
  wantAdmin?: boolean;
}): string {
  const heading = wantAdmin ? "Admin sign-in" : "Dexcom EGV Tester";
  const intro = wantAdmin
    ? "Enter the admin password to open the settings tabs."
    : "Enter the site password to continue.";
  return page(
    "Sign in",
    `<h1>${heading}</h1>
<p>${intro}</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  ${wantAdmin ? `<input type="hidden" name="want" value="admin">` : ""}
  <input type="text" name="username" value="dexcom-egv-tester" autocomplete="username"
    hidden aria-hidden="true" tabindex="-1">
  <label for="password">password</label>
  <input id="password" name="password" type="password" autocomplete="current-password"
    autofocus required>
  <button type="submit">Sign in</button>
</form>`
  );
}

export function renderNotConfiguredPage(missing: string[]): string {
  return page(
    "Not configured",
    `<h1>Not configured</h1>
<p>This site is locked because the server is missing required settings:
${missing.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}.
Set them in the hosting environment and redeploy.</p>`
  );
}

function privatePage(res: Response) {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
}

// ── Handlers ──

/** API paths answer with a status code; everything else gets a page or a redirect. */
function isApiRequest(req: Request): boolean {
  // The OAuth callback is a browser navigation from Dexcom, so treat it as a page.
  return req.path.startsWith("/api/") && req.path !== "/api/dexcom/callback";
}

export function handleSignInPage(req: Request, res: Response) {
  const state = resolveAuthState();
  privatePage(res);
  if (state.mode === "misconfigured") {
    res.status(503).type("html").send(renderNotConfiguredPage(state.missing));
    return;
  }
  if (state.mode === "open") {
    res.redirect(303, "/");
    return;
  }
  res
    .status(200)
    .type("html")
    .send(renderSignInPage({ next: safeNextPath(req.query.next), wantAdmin: req.query.admin === "1" }));
}

export function handleSignIn(
  req: Request,
  res: Response,
  limiter = loginLimiter,
  overallLimiter = overallLoginLimiter
) {
  const state = resolveAuthState();
  privatePage(res);
  if (state.mode === "misconfigured") {
    res.status(503).type("html").send(renderNotConfiguredPage(state.missing));
    return;
  }
  if (state.mode === "open") {
    res.redirect(303, "/");
    return;
  }

  const next = safeNextPath(req.body?.next);
  const wantAdmin = req.body?.want === "admin";
  const ip = clientIp(req);

  if (limiter.isLimited(ip) || overallLimiter.isLimited(OVERALL)) {
    res
      .status(429)
      .type("html")
      .send(renderSignInPage({ next, wantAdmin, error: "Too many attempts. Try again in a few minutes." }));
    return;
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const role = roleForPassword(password, state.config);
  // An admin-upgrade form that receives the viewer password is still a failure.
  const granted = wantAdmin && role !== "admin" ? null : role;

  if (!granted) {
    limiter.recordFailure(ip);
    overallLimiter.recordFailure(OVERALL);
    console.warn(`[Auth] Failed ${wantAdmin ? "admin " : ""}sign-in`);
    if (overallLimiter.isLimited(OVERALL)) {
      console.warn("[Auth] Too many failed sign-ins overall; refusing new sign-ins for up to 15 minutes");
    }
    res
      .status(401)
      .type("html")
      .send(
        renderSignInPage({
          next,
          wantAdmin,
          error: wantAdmin ? "That isn't the admin password." : "Incorrect password.",
        })
      );
    return;
  }

  limiter.reset(ip);
  res.cookie(COOKIE_NAME, createSessionToken(granted, state.config.sessionSecret), {
    ...getSessionCookieOptions(req),
    maxAge: granted === "admin" ? ADMIN_MAX_AGE_MS : VIEWER_MAX_AGE_MS,
  });
  res.redirect(303, next);
}

/**
 * Gate every request. Registered before tRPC, the Dexcom routes and the
 * client, so no page, bundle or API response reaches a signed-out browser.
 * The resolved role is left on res.locals for the tRPC context.
 */
export function requireSession(req: Request, res: Response, next: NextFunction) {
  const state = resolveAuthState();

  if (state.mode === "open") {
    res.locals.role = "admin";
    next();
    return;
  }

  if (state.mode === "misconfigured") {
    privatePage(res);
    if (isApiRequest(req)) {
      res.status(503).json({ error: "Site not configured" });
    } else {
      res.status(503).type("html").send(renderNotConfiguredPage(state.missing));
    }
    return;
  }

  const role = getRoleForRequest(req, state);
  if (role) {
    res.locals.role = role;
    next();
    return;
  }

  privatePage(res);
  if (isApiRequest(req)) {
    res.status(401).json({ error: "Sign in required" });
  } else {
    res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
}

export function registerSessionRoutes(app: Express) {
  const state = resolveAuthState();
  if (state.mode === "open") {
    console.warn("[Auth] VIEWER_PASSWORD is not set — sign-in is disabled (development only).");
  } else if (state.mode === "misconfigured") {
    console.error(`[Auth] Site locked: missing ${state.missing.join(", ")}.`);
  } else {
    if (!state.adminEnabled) console.warn("[Auth] ADMIN_PASSWORD is not set — admin tabs are locked.");
    if (state.config.adminPassword && state.config.adminPassword === state.config.viewerPassword) {
      console.warn("[Auth] VIEWER_PASSWORD and ADMIN_PASSWORD are identical — everyone signs in as admin.");
    }
  }

  app.get("/login", handleSignInPage);
  app.post("/login", (req, res) => handleSignIn(req, res));
}
