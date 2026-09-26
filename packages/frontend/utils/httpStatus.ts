/**
 * The HTTP status an error carries, read defensively — an axios error holds it on
 * `response.status`, the Oxy SDK's normalized error on `status`.
 *
 * Its own module, free of any client, so a hook can ask "was that a 404?"
 * without importing the API client and everything it constructs at load.
 */
export function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  if ('response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'status' in response) {
      const status = (response as { status?: unknown }).status;
      return typeof status === 'number' ? status : undefined;
    }
  }

  if ('status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  return undefined;
}

export function isUnauthorizedError(error: unknown): boolean {
  return getHttpStatus(error) === 401;
}

export function isNotFoundError(error: unknown): boolean {
  return getHttpStatus(error) === 404;
}
