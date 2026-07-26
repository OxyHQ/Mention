/**
 * HTTP client wrapper for the Mention REST API.
 *
 * Token resolution:
 *   Per-request user token from AsyncLocalStorage context (set by HTTP transport).
 *   Returns an empty string when no token is present (unauthenticated read operations).
 *
 * Reads MENTION_API_URL from the environment for the base URL.
 * MENTION_API_TIMEOUT_MS controls the per-attempt timeout (default: 10 seconds).
 */
import { requestContext } from "./context.js";

export interface ApiError {
  status: number;
  message: string;
  body: unknown;
}

const BASE_URL = (process.env.MENTION_API_URL || "https://api.mention.earth").replace(/\/+$/, "");
export const API_REQUEST_TIMEOUT_MS = positiveInteger(
  process.env.MENTION_API_TIMEOUT_MS,
  10_000,
);
const RETRYABLE_GET_STATUSES = new Set([408, 500, 502, 503, 504]);

function resolveToken(): string {
  const ctx = requestContext.getStore();
  return ctx?.userToken || "";
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const token = resolveToken();
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function request<T = unknown>(
  method: string,
  path: string,
  options?: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  },
): Promise<T> {
  const url = buildUrl(path, options?.query);
  const attempts = method === "GET" ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method,
        headers: headers(),
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      if (method === "GET" && attempt === 0) {
        continue;
      }
      throw normalizeNetworkError(error);
    }

    if (
      !response.ok &&
      method === "GET" &&
      attempt === 0 &&
      RETRYABLE_GET_STATUSES.has(response.status)
    ) {
      await response.body?.cancel().catch(() => {});
      continue;
    }

    if (!response.ok) {
      throw await responseToApiError(response);
    }

    // Some endpoints return 204 No Content.
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  throw {
    status: 503,
    message: "Mention API request failed after retry.",
    body: null,
  } satisfies ApiError;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
      throw {
        status: 504,
        message: `Mention API timed out after ${API_REQUEST_TIMEOUT_MS}ms.`,
        body: null,
      } satisfies ApiError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function responseToApiError(response: Response): Promise<ApiError> {
  const rawBody = await response.text().catch(() => "");
  let body: unknown = rawBody;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Preserve non-JSON upstream responses for diagnostics.
    }
  }

  let message: string;
  if (response.status === 401) {
    message = "Authentication required. Provide your Oxy access token as a Bearer token to perform this action.";
  } else if (typeof body === "object" && body !== null && "message" in body) {
    message = String((body as Record<string, unknown>).message);
  } else if (typeof body === "object" && body !== null && "error" in body) {
    message = String((body as Record<string, unknown>).error);
  } else {
    message = `HTTP ${response.status} ${response.statusText}`;
  }

  return { status: response.status, message, body };
}

function normalizeNetworkError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return {
    status: 503,
    message: `Mention API is unavailable: ${detail}`,
    body: null,
  };
}

function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    "message" in error
  );
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const api = {
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return request<T>("GET", path, { query });
  },

  post<T = unknown>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return request<T>("POST", path, { body, query });
  },

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>("PUT", path, { body });
  },

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>("PATCH", path, { body });
  },

  delete<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>("DELETE", path, { body });
  },
};

/**
 * Format an API error into a user-friendly string for MCP tool responses.
 */
export function formatApiError(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error && "message" in error) {
    const apiErr = error as ApiError;
    return `API error (${apiErr.status}): ${apiErr.message}`;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Unknown error: ${String(error)}`;
}
