/**
 * Identity-resolution policy: the entity's display name when it has one (after
 * trimming), otherwise the supplied handle/username fallback.
 *
 * Centralizes the "display name else handle" coalesce that is otherwise repeated
 * across profile, feed, picker, and notification surfaces, so every site applies
 * the exact same rule. The fallback target stays caller-supplied (some sites use
 * `username`, some `@handle`, some another name) — this helper only owns the
 * `displayName?.trim() ||` part.
 */
export function displayNameOrHandle(
  displayName: string | null | undefined,
  fallback: string,
): string {
  return displayName?.trim() || fallback;
}
