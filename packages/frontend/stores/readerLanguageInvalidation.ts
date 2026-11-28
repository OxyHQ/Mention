import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { createFeedRuleSignal } from './feedRuleSignal';

/**
 * The single authority for "the reader's languages changed, so the rendition the
 * server serves of every multilingual post may have changed".
 *
 * Which rendition a reader sees is decided on the SERVER, per request
 * (`PostHydrationService` → `resolveViewerTag`): the first of the reader's
 * languages, in their order, that the author wrote the post in. The answer is
 * more than a body — the link cards, the mentions and the media follow the
 * rendition served — and a machine translation into the reader's primary
 * language is served only when one is cached, which the DTO does not advertise.
 * So a post already on screen cannot be re-resolved here from the variants it
 * shipped with without a second, partial copy of the server's rule; it is asked
 * for again, the same answer `stores/bylineInvalidation` gives for the same
 * reason. The inline variants stay what they are for: switching on an explicit
 * reader action, with no round trip.
 *
 * WHAT COUNTS AS A CHANGE is the part this module owns. The languages are
 * re-derived on every identity render, and most of those are not changes:
 *   - the first languages recorded for a viewer establish them — a cold boot, a
 *     sign-in or an account switch (which clears every cache anyway) must not
 *     throw away the pages that were just read;
 *   - an empty list is not a list yet: a profile projected from Oxy's public
 *     directory carries no languages until the owner profile is read.
 * Only a different list for the SAME viewer is a change, and it is a rare,
 * deliberate act (the language picker), so refetching what is on screen once is
 * the right price.
 */

const signal = createFeedRuleSignal();

let recorded: { viewerId: string; key: string } | null = null;

/**
 * Record the languages the server resolves renditions against for `viewerId` —
 * the Oxy account's languages, primary first, or a signed-out reader's app
 * language — and, when that is a change for the same viewer, refetch every
 * cached post.
 */
export function noteReaderLanguages(viewerId: string, languages: readonly string[]): void {
  if (languages.length === 0) return;
  const key = languages.join(',');
  const previous = recorded;
  recorded = { viewerId, key };
  if (previous === null || previous.viewerId !== viewerId || previous.key === key) return;

  void queryClient.invalidateQueries({
    predicate: (query) => viewerQueryKeys.embedsPosts(query.queryKey),
  });
  signal.notify();
}

/** Whether a feed read at `readAt` predates the reader's current languages. */
export function isFeedCacheStaleForReaderLanguages(readAt: number): boolean {
  return signal.isStale(readAt);
}

/** Subscribe a mounted feed to language changes. Returns an unsubscribe function. */
export function subscribeToReaderLanguageChanges(listener: () => void): () => void {
  return signal.subscribe(listener);
}

/** Forget the recorded languages and change — for tests, and for a viewer switch. */
export function resetReaderLanguageInvalidation(): void {
  recorded = null;
  signal.reset();
}
