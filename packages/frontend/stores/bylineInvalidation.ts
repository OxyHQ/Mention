import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The single authority for "a channel changed whether its posts name the person
 * who wrote them".
 *
 * The write is one boolean — `UserSettings.channel.signPosts`, flipped from
 * `app/(app)/c/[username]/settings.tsx` — and what it changes is who appears on
 * the byline of EVERY post that channel has ever published. `PostHydrationService`
 * appends the writer to `authors[]` as `role: 'writer'` when the channel
 * discloses and omits them when it does not, so the same post comes back with a
 * different author list either side of the toggle.
 *
 * **Why this is a refetch signal rather than a correction applied locally**, which
 * is the question to settle first because Mention now has machinery for the other
 * answer. `stores/identityUpdates` + `lib/actorCache` correct an identity FIELD of
 * an actor a cached post already carries — a changed picture or display name — and
 * they are the right tool for that. They cannot serve this one, in both
 * directions and for two different reasons:
 *
 *   * OFF → ON. The writer is not in the cached DTO to correct, and their id was
 *     never sent to this device: withholding it is the entire point of
 *     `signPosts: false`, and the server decides the disclosure so that no
 *     renderer can get it wrong. There is nothing local to reconstruct the byline
 *     from, so the posts have to be asked for again.
 *   * ON → OFF. The writer IS in the cached DTO and could be stripped out here —
 *     which is exactly the trap. That would be a second implementation of a
 *     server-side disclosure rule, live on one of the two directions only, and it
 *     would disagree with the server the moment that rule gains a case (a
 *     restricted channel, a writer who left). One rule, decided in one place.
 *
 * **Why a sibling module and not a line in `stores/engagementInvalidation`.** That
 * module records that a write changed WHICH POSTS A LIST CONTAINS — a like moves a
 * post into the likes tab, a save into the saved screen — and everything it
 * exposes is shaped around list membership (`engagementKindForFeed` asks whose
 * list it is, because only that viewer's own writes can change it). A byline
 * changes no membership at all: no post enters or leaves any list, and every list
 * that showed the channel yesterday shows exactly the same posts today. It is the
 * CONTENT of rows already held that moved. Folding the two together would make
 * `isFeedCacheStale` answer two different questions under one name, and the next
 * reader would have to know which one their call site meant.
 *
 * The near neighbour is `stores/safetyInvalidation`, and deliberately so — the
 * shape is borrowed from it wholesale, because the situation is the same one:
 * a setting written on a screen pushed OVER the surface that has to converge, and
 * an answer only the server can give. Hence both halves, for the same reasons that
 * file gives at length:
 *
 *   * {@link subscribeToBylineChanges} converges the feeds still mounted
 *     underneath — on this flow, the channel's own page, which is where the
 *     operator came from and where they will land on Back.
 *   * {@link isFeedCacheStaleForByline} converges the rest on their next mount,
 *     because the feed store warm-starts from a retained slice instead of
 *     refetching page 1 and has no staleness notion of its own.
 *
 * **The feed half is global, though the write names one channel.** A channel's
 * posts are not confined to its page: they reach For You, Following, a list feed,
 * a hashtag feed, search — and they ride inside OTHER people's posts as a quote
 * card or a boosted original, so even a feed whose subject is somebody else can be
 * holding one. Answering "could this slice contain that channel?" would mean
 * walking every item of every retained slice on every mount, to save a single
 * refetch of a rare, operator-initiated write. The React Query half below is
 * scoped where scoping is free — the writers list is keyed by channel — and global
 * where it is not.
 */

/** When a channel last changed its byline disclosure, in `Date.now()` terms. */
let changedAt = 0;

/** Notified when a byline changes, so a mounted feed can refetch. */
type BylineListener = () => void;

const listeners = new Set<BylineListener>();

/**
 * Whether a feed cache retained at `retainedAt` predates a byline change, in
 * which case the posts it holds may name a writer the channel has since taken
 * back — or stay anonymous when the channel has since decided to name them.
 *
 * Inclusive for the reason `isFeedCacheStale` in `engagementInvalidation`
 * documents at length: two `Date.now()` stamps can share a millisecond, and a
 * slice retained no later than the change cannot be known to reflect it. The
 * wrong answer here has a name attached to it, which is the direction to be
 * careful in: a row that keeps naming a writer whose channel has just stopped
 * disclosing is a person's identity left on screen after the setting that
 * published it was withdrawn.
 */
export function isFeedCacheStaleForByline(retainedAt: number): boolean {
  return retainedAt <= changedAt;
}

/**
 * Subscribe a mounted feed to byline changes so it refetches without waiting for
 * a remount. Returns an unsubscribe function.
 */
export function subscribeToBylineChanges(listener: BylineListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record that a channel changed whether its posts name their writer, and tell
 * both caches. Call this only after the server has accepted the write: a toggle
 * that failed leaves every surface exactly as the caches already have it, and
 * throwing away a feed for a change that did not land is pure cost.
 *
 * `channelOxyUserId` is the channel whose setting moved. It scopes the one query
 * family that can be scoped — everything else is global, see the note above.
 */
export function noteChannelBylineChanged(channelOxyUserId: string): void {
  changedAt = Date.now();

  void queryClient.invalidateQueries({
    predicate: (query) =>
      // Every family whose cached response embeds a post DTO, and therefore a
      // byline the server has just rewritten:
      //   `posts`       — the post detail behind a notification, and a profile's
      //                   pinned post, which on a channel's page is the channel's
      //                   own. `scheduledPosts` rides in the same family and is
      //                   collateral rather than a target: `GET /posts/scheduled`
      //                   matches `oxyUserId: <caller>`, and a post published as a
      //                   channel carries the CHANNEL's id, so an operator's
      //                   scheduled list cannot hold one.
      //   `saved-posts` — the saved screen, React Query's own post list.
      //   `search`      — the posts tab.
      //   `notifications` — rows embed the post they are about, and the server
      //                   applies the same disclosure decision to them.
      viewerQueryKeys.isFamily(query.queryKey, 'posts')
      || viewerQueryKeys.isFamily(query.queryKey, 'saved-posts')
      || viewerQueryKeys.isFamily(query.queryKey, 'search')
      || viewerQueryKeys.isFamily(query.queryKey, 'notifications')
      // And the writers list itself, which this setting does not merely change
      // but decides the EXISTENCE of: the endpoint 404s for a channel that does
      // not disclose, and `useChannelWriters` reads that refusal as "no tab".
      // Keyed by channel, so only this one is asked to fetch again.
      || viewerQueryKeys.isChannelWriters(query.queryKey, channelOxyUserId),
  });

  for (const listener of listeners) {
    listener();
  }
}

/**
 * Drop the recorded change. For tests.
 *
 * Deliberately NOT wired into the account switch, unlike `resetEngagementInvalidation`
 * and `resetSafetyInvalidation` beside it, and for the reason `resetIdentityUpdates`
 * gives: those two record something about the VIEWER — their own engagements, their
 * own safety rules — which says nothing about the next viewer. A channel's byline is
 * the channel's fact and is the same fact whoever is signed in. It would also be
 * inert either way: the switch drops every retained slice, so every slice the next
 * viewer holds is retained after this stamp and none of them is condemned by it.
 */
export function resetBylineInvalidation(): void {
  changedAt = 0;
}
