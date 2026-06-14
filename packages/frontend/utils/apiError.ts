import axios from 'axios';

/**
 * Normalized, transport-agnostic view of a caught error.
 *
 * Extracted once from an `unknown` value so services, hooks, and screens don't
 * each re-implement the (error-prone) narrowing of axios / `Error` / serialized
 * shapes. Every field is optional because the source may be anything that was
 * `throw`n — including non-`Error` values.
 */
export interface NormalizedApiError {
  /** HTTP status code, when the failure came back from the server. */
  status?: number;
  /**
   * Stable machine-readable code. Either the backend's `code`/`error` field or,
   * for transport-level failures, a synthetic code (e.g. `NETWORK`, `TIMEOUT`).
   */
  code?: string;
  /** Best human-readable message available (server message preferred). */
  message: string;
}

/** Shape we defensively read off a JSON error body returned by the backend. */
interface ServerErrorBody {
  message?: unknown;
  error?: unknown;
  code?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Walk a value to find a thrown error's `cause` chain produced via
 * `new Error(msg, { cause })`. Returns the first link (depth-1) so callers can
 * inspect the underlying transport error that a service preserved.
 */
function unwrapCause(error: unknown): unknown {
  if (error instanceof Error && 'cause' in error && error.cause !== undefined) {
    return error.cause;
  }
  if (isRecord(error) && 'cause' in error && error.cause !== undefined) {
    return error.cause;
  }
  return undefined;
}

/**
 * Extract a typed `{ status, code, message }` from any caught value.
 *
 * Input is `unknown` and narrowed with type guards — never `any`. The original
 * error and its `cause` (when a service rethrew with `new Error(msg, { cause })`)
 * are both inspected so context preserved upstream is recovered here.
 */
export function normalizeApiError(error: unknown): NormalizedApiError {
  // Prefer the underlying transport error when one was preserved as `cause`.
  // A service may have rethrown `new Error('Failed to ...', { cause: axiosErr })`,
  // in which case the status/code live on the cause, not the wrapper.
  const cause = unwrapCause(error);

  for (const candidate of [error, cause]) {
    if (candidate === undefined) continue;

    if (axios.isAxiosError(candidate)) {
      const status = candidate.response?.status;
      const body = candidate.response?.data;
      const serverMessage = isRecord(body)
        ? readString((body as ServerErrorBody).message) ?? readString((body as ServerErrorBody).error)
        : undefined;
      const serverCode = isRecord(body) ? readString((body as ServerErrorBody).code) : undefined;

      let code = serverCode;
      if (!code) {
        if (candidate.code === 'ECONNABORTED' || candidate.code === 'ETIMEDOUT') {
          code = 'TIMEOUT';
        } else if (status === undefined) {
          // No response at all → request never reached the server.
          code = 'NETWORK';
        }
      }

      const message =
        serverMessage ??
        candidate.message ??
        (status !== undefined ? `Request failed with status ${status}` : 'Network request failed');

      return { status, code, message };
    }
  }

  // Non-axios path: a service may have rethrown a plain Error and stamped a
  // numeric `status`/string `code` onto it.
  for (const candidate of [error, cause]) {
    if (isRecord(candidate)) {
      const status = typeof candidate.status === 'number' ? candidate.status : undefined;
      const code = readString(candidate.code);
      const message = readString(candidate.message);
      if (status !== undefined || code !== undefined || message !== undefined) {
        return {
          status,
          code,
          message: message ?? 'Unexpected error',
        };
      }
    }
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: typeof error === 'string' && error.length > 0 ? error : 'Unexpected error' };
}

/** `true` when the failure is a client/network connectivity problem, not a server response. */
export function isNetworkError(error: NormalizedApiError): boolean {
  return error.status === undefined && (error.code === 'NETWORK' || error.code === 'TIMEOUT');
}

/** `true` when the server rejected the request as rate limited. */
export function isRateLimitError(error: NormalizedApiError): boolean {
  return error.status === 429 || error.code === 'RATE_LIMITED';
}

/**
 * `true` when the request was rejected as invalid input (bad request /
 * unprocessable entity), e.g. a post that is too long or otherwise malformed.
 */
export function isValidationError(error: NormalizedApiError): boolean {
  return error.status === 400 || error.status === 422 || error.code === 'VALIDATION';
}

/**
 * Stable, transport-agnostic classification of a failed mutation, suitable for
 * mapping to a localized user-facing message. Shared so screens and hooks
 * classify identically.
 */
export type ApiErrorReason = 'validation' | 'rateLimited' | 'network' | 'server';

/** Classify a caught error into a {@link ApiErrorReason} for user messaging. */
export function classifyApiError(error: unknown): { reason: ApiErrorReason; normalized: NormalizedApiError } {
  const normalized = normalizeApiError(error);
  let reason: ApiErrorReason = 'server';
  if (isRateLimitError(normalized)) {
    reason = 'rateLimited';
  } else if (isValidationError(normalized)) {
    reason = 'validation';
  } else if (isNetworkError(normalized)) {
    reason = 'network';
  }
  return { reason, normalized };
}
