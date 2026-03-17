/**
 * HTTP client wrapper for the Mention REST API.
 *
 * Token resolution order:
 *   1. Per-request user token from AsyncLocalStorage context (set by HTTP transport)
 *   2. OXY_SERVICE_TOKEN env var (service-level fallback)
 *
 * Reads MENTION_API_URL from the environment for the base URL.
 */
import { requestContext } from "./context.js";

export interface ApiError {
  status: number;
  message: string;
  body: unknown;
}

const BASE_URL = (process.env.MENTION_API_URL || "https://api.mention.earth").replace(/\/+$/, "");

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

  const init: RequestInit = {
    method,
    headers: headers(),
  };

  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => "");
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

    const error: ApiError = { status: response.status, message, body };
    throw error;
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
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
