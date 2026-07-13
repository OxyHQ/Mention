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
