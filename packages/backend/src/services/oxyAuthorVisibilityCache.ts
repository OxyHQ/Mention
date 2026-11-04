/**
 * Whether Oxy serves an author's public profile, remembered for a short while.
 *
 * Every crawled post page asks it for each author it shows (`webShell.routes`),
 * and the answer costs one to three Oxy calls. Asked fresh on every request, a
 * crawler's volume became Oxy calls against Mention's shared service budget.
 *
 * WHY IT WAS UNCACHED, and why this still honours it: the answer is a privacy
 * gate. An author Oxy stops serving (archived, restricted, erased) must leave
 * crawled pages promptly, not an hour later with the card cache. So:
 *  - a PUBLIC answer lives {@link PUBLIC_TTL_SECONDS}: the longest a hidden
 *    author can still be shown if the eviction below is lost;
 *  - a HIDDEN answer lives longer ({@link HIDDEN_TTL_SECONDS}): a stale one only
 *    keeps a page `noindex` a little longer, and it absorbs a crawler storm on a
 *    hidden author's posts;
 *  - a FAILED read is never cached — it propagates, and the page is a 503 that
 *    asks again, as before;
 *  - Oxy's user-invalidation broadcast evicts the entry on every task the moment
 *    the account changes (`userInvalidationSubscriber`), and an erasure evicts it
 *    with the account's other caches. The TTLs only bound a lost message.
 */
import { createCache } from '../utils/cache';

const PREFIX = 'oxy-author-public:v1:';
const PUBLIC_TTL_SECONDS = 60;
const HIDDEN_TTL_SECONDS = 5 * 60;

const cache = createCache({ name: 'OxyAuthorVisibilityCache', ttlSeconds: PUBLIC_TTL_SECONDS });

/** The cached answer for `oxyUserId`, computed by `ask` on a miss. `ask`'s rejection is not cached. */
export function cachedOxyAuthorVisibility(
  oxyUserId: string,
  ask: () => Promise<boolean>,
): Promise<boolean> {
  return cache.getOrCompute(PREFIX + oxyUserId, ask, {
    ttlSecondsFor: (isPublic) => (isPublic ? PUBLIC_TTL_SECONDS : HIDDEN_TTL_SECONDS),
  });
}

/** Forget the answers for these accounts, so the next page asks Oxy again. */
export async function invalidateOxyAuthorVisibility(oxyUserIds: string[]): Promise<void> {
  await cache.delete(oxyUserIds.map((oxyUserId) => PREFIX + oxyUserId));
}
