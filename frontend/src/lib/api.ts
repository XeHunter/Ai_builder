/**
 * Thin fetch wrapper for the OmniPulse API.
 *
 * - Browser sessions use the httpOnly `op_session` cookie set by POST /auth/login, so no token is
 *   ever stored in JavaScript-accessible storage.
 * - Every non-2xx response is converted into an `ApiError` carrying the backend error envelope
 *   ({error: {code, message, details, request_id}}).
 */

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  requestId: string | null;

  constructor(status: number, code: string, message: string, details: unknown, requestId: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the raw text body instead of JSON (e.g. CSV downloads). */
  asText?: boolean;
}

export function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}/api/v1${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (opts.body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
      credentials: "include",
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network_error", "Cannot reach the OmniPulse API. Is the backend running?", null, null);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let code = "http_error";
    let message = res.statusText || "Request failed";
    let details: unknown = null;
    let requestId: string | null = res.headers.get("x-request-id");
    try {
      const body = JSON.parse(text);
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        details = body.error.details ?? null;
        requestId = body.error.request_id ?? requestId;
      }
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, code, message, details, requestId);
  }
  if (opts.asText) return text as T;
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => apiRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) => apiRequest<T>(path, { method: "POST", body: body ?? {}, query }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PUT", body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PATCH", body: body ?? {} }),
  delete: <T>(path: string, query?: Query) => apiRequest<T>(path, { method: "DELETE", query }),
  upload: <T>(path: string, form: FormData, headers?: Record<string, string>) =>
    apiRequest<T>(path, { method: "POST", body: form, headers }),
  text: (path: string, query?: Query) => apiRequest<string>(path, { query, asText: true }),
};

/** Human-readable message for any thrown value (used by toasts and inline error states). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const violations = (err.details as { violations?: unknown[] } | null)?.violations;
    if (Array.isArray(violations) && violations.length) {
      const text = violations.map((v) => (typeof v === "string" ? v : (v as { message?: string })?.message ?? "")).filter(Boolean);
      return `${err.message}: ${text.join(" ")}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

export function wsUrl(path: string): string {
  const base = API_BASE || window.location.origin;
  const u = new URL(`${base}/api/v1${path}`);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}
