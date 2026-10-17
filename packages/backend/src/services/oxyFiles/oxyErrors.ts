/**
 * Reading an `@oxy.so/core` request failure without trusting its shape: the
 * SDK throws `HttpRequestError` (`status`, `code`) from `HttpService`, but a
 * transport failure is a plain `Error` and a rejection can be anything.
 */

/** The HTTP status of a failed Oxy call, when it reached Oxy. */
export function oxyErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.response?.status === 'number') return record.response.status;
  return undefined;
}

/** Oxy's machine-readable error code (`SOURCE_URL_REFUSED`, …), when it sent one. */
export function oxyErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown; response?: { data?: unknown } };
  if (typeof record.code === 'string' && record.code.length > 0) return record.code;
  const data = record.response?.data as { error?: unknown; code?: unknown } | undefined;
  if (typeof data?.code === 'string') return data.code;
  if (typeof data?.error === 'string') return data.error;
  if (data?.error && typeof data.error === 'object') {
    const code = (data.error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** A short, non-sensitive description for a log line or a `last_error` column. */
export function describeOxyError(error: unknown): string {
  const status = oxyErrorStatus(error);
  const code = oxyErrorCode(error);
  if (status !== undefined) return code ? `HTTP ${status} ${code}` : `HTTP ${status}`;
  if (error instanceof Error)
    return error.name === 'Error' ? error.message.slice(0, 120) : error.name;
  return 'unknown';
}
