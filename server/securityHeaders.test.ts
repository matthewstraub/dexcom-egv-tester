import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { HSTS_MAX_AGE_SECONDS, strictTransportSecurity } from "./_core/securityHeaders";

function run(req: Partial<Request>) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => void (headers[name] = value) } as unknown as Response;
  const next = vi.fn();
  strictTransportSecurity({ protocol: "http", headers: {}, ...req } as Request, res, next);
  return { headers, next };
}

describe("strictTransportSecurity", () => {
  it("tells browsers to use HTTPS for a year on a secure request", () => {
    const { headers, next } = run({ protocol: "https" });
    expect(headers["Strict-Transport-Security"]).toBe(`max-age=${HSTS_MAX_AGE_SECONDS}`);
    expect(HSTS_MAX_AGE_SECONDS).toBe(31_536_000);
    expect(next).toHaveBeenCalledOnce();
  });

  it("recognises HTTPS that a proxy like Render terminated", () => {
    const { headers } = run({ protocol: "http", headers: { "x-forwarded-proto": "https" } });
    expect(headers["Strict-Transport-Security"]).toBeDefined();
  });

  it("stays off plain HTTP, such as local development", () => {
    const { headers, next } = run({ protocol: "http" });
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
