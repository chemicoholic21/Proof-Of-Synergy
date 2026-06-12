import { NextResponse } from "next/server";
import { ZodError, ZodTypeAny, z } from "zod";
import { logger } from "./logger";
import { rateLimit, clientIp } from "./rateLimit";

/**
 * Shared helpers for API route handlers: request IDs, consistent JSON error envelopes,
 * rate limiting and schema-validated body parsing.
 */

// crypto.randomUUID is available in the Node and Edge runtimes Next uses.
export function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export interface ApiError {
  error: string;
  code: string;
  requestId: string;
  details?: unknown;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: { details?: unknown; headers?: Record<string, string> }
): NextResponse {
  const body: ApiError = { error: message, code, requestId };
  if (extra?.details !== undefined) body.details = extra.details;
  return NextResponse.json(body, { status, headers: extra?.headers });
}

/** Enforce a per-client rate limit. Returns a 429 response when exceeded, else null. */
export function enforceRateLimit(
  req: Request,
  route: string,
  requestId: string,
  opts?: { max?: number; windowMs?: number }
): NextResponse | null {
  const ip = clientIp(req);
  const result = rateLimit(`${route}:${ip}`, opts);
  if (result.ok) return null;
  logger.warn("rate limit exceeded", { requestId, route, ip });
  return errorResponse(429, "rate_limited", "Too many requests. Please slow down.", requestId, {
    headers: {
      "retry-after": String(result.retryAfterSec),
      "x-ratelimit-limit": String(result.limit),
      "x-ratelimit-remaining": "0",
    },
  });
}

/** Parse and validate a JSON request body against a schema. Throws ValidationError on failure. */
export class ValidationError extends Error {
  constructor(public details: unknown) {
    super("Request validation failed");
    this.name = "ValidationError";
  }
}

export async function parseJsonBody<S extends ZodTypeAny>(
  req: Request,
  schema: S
): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ValidationError("Body must be valid JSON");
  }
  try {
    return schema.parse(json);
  } catch (e) {
    if (e instanceof ZodError) throw new ValidationError(e.flatten());
    throw e;
  }
}
