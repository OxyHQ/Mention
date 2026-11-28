/** A plain object: not null, not an array. The shape check for untyped JSON. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
