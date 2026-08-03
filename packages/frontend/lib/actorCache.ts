import { upsertCachedUser, upsertCachedUsers, type CacheableUser } from '@oxyhq/services';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  applyKnownIdentity,
  recordIdentityChange,
  reconcileKnownIdentities,
  type IdentityUpdate,
} from '@/stores/identityUpdates';

/**
 * The ONE door into the SDK's user cache — Mention's in-memory actor cache.
 *
 * Six surfaces fetch users and prime that cache with what they got: the feed's
 * post authors, the recommendation rail, the suggested-users card, the profile
 * interstitial, the followers/following lists and the mention picker's
 * enrichment. Each of them was calling the SDK's merge-upsert directly, and the
 * merge overrides a real value with a real value — so ANY of them could put a
 * server copy that predates a profile edit back over that edit, which is exactly
 * what the feed was doing on a channel's own page.
 *
 * Guarding them one by one would be six guards, and six guards is the shape that
 * quietly becomes five when somebody adds a seventh surface. They all pass the
 * SAME singleton query client to the SAME two SDK functions, so they can all
 * pass through here instead, and the correction is written once. That is also
 * why this module — not the store behind it — is the thing new code should
 * import: it is enforceable by grep (`@oxyhq/services`'s upserts have exactly
 * one caller in the app, this file) in a way that "remember to correct your
 * actors" is not.
 *
 * It owns the WRITE half of identity as well ({@link noteIdentityChanged}),
 * because a profile edit is the same question from the other side: the cache
 * this module fronts is one of the two places that edit has to reach. The other
 * is the post rows, which read `stores/identityUpdates` directly.
 *
 * The dependency runs one way — this may import the overlay store, never the
 * reverse. The store is in `PostItem`'s module graph and must stay free of the
 * SDK barrel; see the note at the top of `stores/identityUpdates.ts`.
 */

/**
 * Prime the cache with actors a surface just fetched.
 *
 * Reconciles FIRST: an actor the server has caught up with retires its overlay
 * entry, so the correction that follows is a no-op from then on and an identity
 * changed somewhere else is never pinned to what this session wrote.
 */
export function cacheActors(actors: readonly CacheableUser[] | null | undefined): void {
  if (!Array.isArray(actors) || actors.length === 0) return;
  reconcileKnownIdentities(actors);
  upsertCachedUsers(queryClient, actors.map(applyKnownIdentity));
}

/** {@link cacheActors} for a single actor. */
export function cacheActor(actor: CacheableUser | null | undefined): void {
  if (!actor) return;
  reconcileKnownIdentities([actor]);
  upsertCachedUser(queryClient, applyKnownIdentity(actor));
}

/**
 * Record that a profile edit landed, and tell every cache holding a copy of that
 * identity. Call this only after the server has accepted the write: a failed
 * edit leaves every surface exactly as the caches already have it.
 */
export function noteIdentityChanged(update: IdentityUpdate, viewerId?: string): void {
  const stored = recordIdentityChange(update);
  if (!stored) return;

  // The SDK's canonical merge-upsert writes BOTH keys its user hooks read (by-id
  // and the viewer-scoped by-username) and merges rather than replaces — so the
  // profile screen, the hover card and every `useUserById` card get the edit
  // without losing the counts and viewer relationship an authoritative profile
  // fetch had already stored. Not routed through `cacheActor`: this is the
  // authority for that identity, so it must not be reconciled against itself.
  upsertCachedUser(queryClient, stored, viewerId);

  // The operated-accounts list embeds each account's profile and feeds the
  // channels screen, the composer's publish-as picker and the channel settings
  // screen itself. It is a list of accounts rather than an actor cache, so the
  // upsert above cannot reach it.
  void queryClient.invalidateQueries({
    predicate: (query) => viewerQueryKeys.isOperatedAccounts(query.queryKey),
  });
}
