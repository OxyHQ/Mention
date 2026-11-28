/**
 * The one mechanism behind every "a rule the SERVER applies changed" authority —
 * `stores/safetyInvalidation`, `stores/bylineInvalidation` and
 * `stores/readerLanguageInvalidation`.
 *
 * Each of those owns a rule the client cannot re-apply to what it already holds,
 * so a change means asking again, and a feed has to hear about it two ways: a
 * feed still MOUNTED under the settings screen where the change was made
 * ({@link FeedRuleSignal.subscribe}, through `hooks/useReloadOnFeedRuleChange`),
 * and a feed that warm-starts later from pages read before it
 * ({@link FeedRuleSignal.isStale}, through `stores/feedStaleness`). What each
 * authority invalidates in React Query, and what counts as a change, stays in
 * the authority; only the stamp and the listeners live here.
 */
export interface FeedRuleSignal {
  /**
   * Whether a feed read at `readAt` predates the last change. Inclusive for the
   * reason `isFeedCacheStale` in `engagementInvalidation` documents: two
   * `Date.now()` stamps can share a millisecond, and a read made no later than
   * the change cannot be known to reflect it.
   */
  isStale: (readAt: number) => boolean;
  /** Subscribe a mounted feed so it reads again on a change. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Record a change now and tell every mounted feed. */
  notify: () => void;
  /** Forget the recorded change — for tests, and for a viewer switch. */
  reset: () => void;
}

export function createFeedRuleSignal(): FeedRuleSignal {
  let changedAt = 0;
  const listeners = new Set<() => void>();
  return {
    isStale: (readAt) => readAt <= changedAt,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      changedAt = Date.now();
      for (const listener of listeners) listener();
    },
    reset() {
      changedAt = 0;
    },
  };
}
