export function deckEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const right = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        deckEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
/** Three-way reconciliation: only locally changed fields override the server. */
export function mergeDeckChanges<T>(base: T, local: T, remote: T): T {
  if (deckEqual(base, local)) return remote;
  if (
    !base ||
    !local ||
    !remote ||
    typeof base !== 'object' ||
    typeof local !== 'object' ||
    typeof remote !== 'object' ||
    Array.isArray(base) ||
    Array.isArray(local) ||
    Array.isArray(remote)
  )
    return local;
  const result: Record<string, unknown> = { ...(remote as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    const b = (base as Record<string, unknown>)[key];
    const l = (local as Record<string, unknown>)[key];
    if (deckEqual(b, l)) continue;
    if (!(key in local)) delete result[key];
    else if (key === 'navigation') result[key] = l;
    else result[key] = mergeDeckChanges(b, l, (remote as Record<string, unknown>)[key]);
  }
  return result as T;
}
