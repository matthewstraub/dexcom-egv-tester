import type { NextFunction, Request, Response } from "express";
import { isSecureRequest } from "./cookies";

/** One year. A browser that has seen the header uses HTTPS for the site until it lapses. */
export const HSTS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * HTTP Strict Transport Security. After one secure visit, the browser upgrades
 * any http:// link to this site to HTTPS before sending anything, so there's
 * no unencrypted first request for someone on the network to intercept.
 *
 * Sent only on HTTPS requests, as the spec requires (browsers ignore it over
 * plain HTTP anyway). Render terminates TLS in front of the app, so
 * isSecureRequest reads X-Forwarded-Proto; local http://localhost never gets it.
 */
export function strictTransportSecurity(req: Request, res: Response, next: NextFunction) {
  if (isSecureRequest(req)) {
    res.setHeader("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE_SECONDS}`);
  }
  next();
}
