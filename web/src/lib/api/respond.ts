// JSON responses, errors and paging for the REST API. Every response carries
// the API version and revision headers; errors are { error, code } with the
// matching status — the handler wrapper (lib/api/handler.ts) turns a thrown
// ApiError into one, so route code just throws.
import { NextResponse } from "next/server";
import type { PageState } from "@/lib/paginate-shared";
import { API_REVISION, API_VERSION } from "./version";

export type ApiErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "unprocessable" | "api_disabled" | "rate_limited" | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  api_disabled: 403,
  rate_limited: 429,
  internal: 500,
};

/** What every endpoint answers while an administrator has the API switched off. */
export const apiDisabled = () =>
  new ApiError("api_disabled", "The REST API is switched off on this registry (Administration → Auth providers → Access).");

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get status(): number {
    return STATUS[this.code];
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new ApiError("bad_request", message, details);
export const unauthorized = (message = "Authentication required.") => new ApiError("unauthorized", message);
export const forbidden = (message = "You don't have permission to do that.") => new ApiError("forbidden", message);
export const notFound = (message = "Not found.") => new ApiError("not_found", message);
export const conflict = (message: string) => new ApiError("conflict", message);
export const unprocessable = (message: string, details?: Record<string, unknown>) => new ApiError("unprocessable", message, details);

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    Vary: "Authorization, Cookie",
    "X-Api-Version": String(API_VERSION),
    "X-Api-Revision": API_REVISION,
    ...extra,
  };
}

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): NextResponse {
  return NextResponse.json(body, { status: init.status ?? 200, headers: apiHeaders(init.headers) });
}

export function errorResponse(err: ApiError): NextResponse {
  const headers: Record<string, string> = {};
  if (err.code === "unauthorized") headers["WWW-Authenticate"] = 'Bearer realm="chicoree-api"';
  if (err.code === "rate_limited" && typeof err.details?.retryAfter === "number") headers["Retry-After"] = String(err.details.retryAfter);
  return json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, { status: err.status, headers });
}

/** The JSON body of a request as an object; empty bodies are {}. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("The request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

/** A string field of a JSON body, trimmed; undefined when absent, an error when not a string. */
export function stringField(body: Record<string, unknown>, key: string, maxLength = 1000): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw unprocessable(`"${key}" must be a string.`);
  if (v.length > maxLength) throw unprocessable(`"${key}" is longer than ${maxLength} characters.`);
  return v.trim();
}

/**
 * A whole-number field that may be null: absent → undefined, null → null,
 * a non-negative integer → the number; anything else is an error.
 */
export function nullableIntField(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number } = {}): number | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw unprocessable(`"${key}" must be a whole number${min > 0 ? ` of at least ${min}` : ""} or null.`);
  return v;
}

export function enumField<T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !values.includes(v as T)) throw unprocessable(`"${key}" must be one of ${values.join(", ")}.`);
  return v as T;
}

/** `?flag=true|1|yes` → true; absent → the default. */
export function boolParam(url: URL, key: string, fallback = false): boolean {
  const v = url.searchParams.get(key);
  if (v === null) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** `page` and `per_page` from the query string, clamped. */
export function pageParams(url: URL, opts: { defaultSize?: number; max?: number } = {}): { page: number; pageSize: number } {
  const max = opts.max ?? 100;
  const fallback = opts.defaultSize ?? 50;
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page") ?? 1)) || 1);
  const raw = Math.trunc(Number(url.searchParams.get("per_page") ?? fallback));
  const pageSize = Number.isFinite(raw) && raw > 0 ? Math.min(raw, max) : fallback;
  return { page, pageSize };
}

export interface Paged<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  pages: number;
}

export function paged<T>(items: T[], state: PageState): Paged<T> {
  return { items, page: state.page, perPage: state.pageSize, total: state.total, pages: state.pages };
}

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export function requireDigest(value: string): string {
  const d = decodeURIComponent(value).trim().toLowerCase();
  if (!DIGEST_RE.test(d)) throw badRequest("The digest must look like sha256:<64 hex characters>.");
  return d;
}

/** ISO string or null — every timestamp the API returns goes through here. */
export function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
