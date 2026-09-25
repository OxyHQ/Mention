/**
 * The tabs navigator's state, reduced to the fields a LEAVE rewrites.
 *
 * Structural rather than imported: the navigator's full state type lives in
 * expo-router's vendored react-navigation, and the only promise this file makes
 * is to hand back the same object with `index` and `history` changed — so any
 * other field (the preloaded keys, `stale`, the router's own key) passes through
 * untouched.
 */
export interface LeavableTabState {
  index: number;
  routes: readonly { key: string; name: string }[];
  /**
   * `unknown` because that is how the navigator types it: entries are
   * `{ type: 'route', key }` records, read structurally below.
   */
  history?: readonly unknown[];
}

const historyKey = (entry: unknown): string | undefined =>
  typeof entry === 'object' && entry !== null && 'key' in entry && typeof entry.key === 'string'
    ? entry.key
    : undefined;

/**
 * The tabs state after leaving page `fromName` for page `toName`, with the page
 * being left REMOVED from the back history.
 *
 * WHY THIS EXISTS. The tabs navigator keeps a back history
 * (`backBehavior: 'history'`, `app/(app)/(tabs)/_layout.tsx`), and a plain
 * switch only re-orders it: leaving the composer tab for Home turns
 * `[index, write]` into `[write, index]`. The composer is still one Back away,
 * holding whatever it held when the reader left it. For an unsent draft that is
 * the point; for a post that has just been PUBLISHED it is a duplicate waiting to
 * happen (OxyHQ/Mention#1140), so a publish leaves the composer this way instead.
 *
 * Returns `null` when either page names a route this navigator does not have,
 * so the caller can fall back to an ordinary switch rather than dispatch a state
 * the router would reject.
 */
export function stateLeavingTab<S extends LeavableTabState>(
  state: S,
  fromName: string,
  toName: string,
): S | null {
  const toIndex = state.routes.findIndex((route) => route.name === toName);
  const from = state.routes.find((route) => route.name === fromName);
  const to = state.routes[toIndex];
  if (!from || !to) return null;

  const history = (state.history ?? []).filter((entry) => {
    const key = historyKey(entry);
    return key !== from.key && key !== to.key;
  });
  return {
    ...state,
    index: toIndex,
    history: [...history, { type: 'route', key: to.key }],
  };
}
