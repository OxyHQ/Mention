/**
 * Whether a feed renders by slice (threads grouped) rather than by item.
 *
 * Every feed is one list now (`data/feeds`), but the two earlier paths drew
 * them differently and that look is kept: web and scoped feeds render the
 * server's slices; native unscoped feeds render items, with their social
 * context beside them (the SQLite path never stored slices).
 *
 * @param useScoped - true when the feed has filters (postId, parentPostId, etc.)
 * @param dbAvailable - true on native, false on web
 */
export function resolveUseMemoryFeed(
  useScoped: boolean | undefined,
  dbAvailable: boolean,
): boolean {
  return !!useScoped || !dbAvailable;
}
