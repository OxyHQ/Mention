import { isAuthenticationError, OxyAuthenticationError } from '@oxyhq/core';

/** Stable code emitted by Oxy auth-timeout errors. */
const AUTH_TIMEOUT_CODE = 'AUTH_TIMEOUT';

/** Substrings present in serialized Oxy auth-error messages. */
const AUTH_MESSAGE_FRAGMENTS = [
  'requires user authentication',
  'Authentication timeout',
] as const;

/** Narrow shape we defensively read off serialized (non-instance) errors. */
interface SerializedAuthError {
  code?: string;
  message?: string;
}

/**
 * Returns `true` when the given error represents an Oxy authentication failure
 * (e.g. a session/token that the SDK requires but the caller does not have).
 *
 * Detection order:
 * 1. Core's own {@link isAuthenticationError} (canonical source of truth).
 * 2. `instanceof` {@link OxyAuthenticationError} (covers subclasses like the
 *    timeout error).
 * 3. A defensive fallback for errors that crossed a serialization boundary and
 *    lost their prototype — matched by `code` or message fragment.
 */
export function isAuthError(error: unknown): boolean {
  if (isAuthenticationError(error)) return true;
  if (error instanceof OxyAuthenticationError) return true;

  if (error && typeof error === 'object') {
    const { code, message } = error as SerializedAuthError;
    if (code === AUTH_TIMEOUT_CODE) return true;
    if (typeof message === 'string' && AUTH_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) {
      return true;
    }
  }

  return false;
}
