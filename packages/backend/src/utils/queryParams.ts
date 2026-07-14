/**
 * Boundary readers for HTTP query parameters.
 *
 * Express (qs) parses `?x[]=a&x[]=b` into an ARRAY and `?x[k]=v` into an OBJECT,
 * so `req.query.x` is `string | string[] | ParsedQs | ParsedQs[] | undefined`.
 * Casting it (`req.query.x as string`) is a lie the type system happily accepts,
 * and it lets a tampered URL push a non-string into code that reads it as one —
 * indexing it, or calling `.charCodeAt` / `.trim` / `.toLowerCase` on it — which
 * throws an unhandled TypeError and turns a crafted request into a 500.
 *
 * Anything that is not a string is treated as ABSENT rather than coerced: a
 * tampered parameter must never be silently rewritten into a plausible-looking
 * value (`String(['for_you'])` is `'for_you'`, which would defeat the check).
 */

/** The parameter's string value, or `undefined` if it was absent or tampered with. */
export function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The parameter parsed as a base-10 integer, or `undefined` if it was absent,
 * tampered with, or not a number.
 *
 * Callers pick their own default and bounds, so this deliberately does not clamp:
 * `queryInt(req.query.limit) || DEFAULT_PAGE_SIZE` reads the same as the
 * `parseInt(...) || DEFAULT_PAGE_SIZE` it replaces, down to `0` falling back to
 * the default.
 */
export function queryInt(value: unknown): number | undefined {
  const raw = queryString(value);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The parameter's NESTED value (`?filters[parentPostId]=x`), or `undefined` when
 * it is absent or arrived as some other shape.
 *
 * Unlike the readers above, an object here is the legitimate shape rather than
 * the tampered one — but a caller that reaches into `.parentPostId` still has to
 * know it did not get a string or an array first.
 */
export function queryRecord(value: unknown): Record<string, unknown> | undefined {
  return isQueryRecord(value) ? value : undefined;
}

function isQueryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
