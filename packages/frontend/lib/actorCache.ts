import { currentStore, type Store, withStore } from '@oxy.so/bloom-data';
import {
  storeUsers,
  type CacheableUser,
  type UpsertCachedUserOptions,
} from '@oxy.so/services/ui/client';
import { captureAccount, currentAccountId } from '@/lib/accountScope';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  applyKnownIdentity,
  recordIdentityChange,
  reconcileKnownIdentities,
  type IdentityUpdate,
} from '@/stores/identityUpdates';

/**
 * The ONE door into the SDK's user cache — Services' `User`, held in the
 * signed-in account's bloom-data store (Services 15; it was a React Query
 * cache on Services 14).
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
 * SAME SDK function (`storeUsers`), so they can all pass through here instead,
 * and the correction is written once. That is also why this module — not the
 * store behind it — is the thing new code should import: it is enforceable by
 * grep (`storeUsers` has exactly one caller in the app, this file) in a way
 * that "remember to correct your actors" is not.
 *
 * A surface that fetches takes an {@link actorWriter} BEFORE it awaits and
 * writes the answer through it: the writer is bound to the account's store and
 * to the account itself, so an answer that lands after a switch is dropped
 * instead of putting the previous account's people (and their viewer-relative
 * `relationship`) into the next account's store.
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

/** Writes actors into the store of the account that was signed in when it was made. */
export interface ActorWriter {
  /**
   * Prime the cache with actors a surface just fetched.
   *
   * Reconciles FIRST: an actor the server has caught up with retires its overlay
   * entry, so the correction that follows is a no-op from then on and an identity
   * changed somewhere else is never pinned to what this session wrote.
   */
  cacheActors(actors: readonly CacheableUser[] | null | undefined): void;
  /** {@link ActorWriter.cacheActors} for a single actor. */
  cacheActor(actor: CacheableUser | null | undefined): void;
}

/** Whether a write captured for `store` may still land: same account, store still open. */
function writable(store: Store, isCurrent: () => boolean): boolean {
  return isCurrent() && !store.closed;
}

/** An {@link ActorWriter} for the signed-in account now: take it before the request. */
export function actorWriter(): ActorWriter {
  const store = currentStore();
  const token = captureAccount();
  const write = (actors: readonly CacheableUser[]) => {
    if (actors.length === 0 || !writable(store, token.isCurrent)) return;
    reconcileKnownIdentities(actors);
    withStore(store, () => storeUsers(actors.map(applyKnownIdentity)));
  };
  return {
    cacheActors(actors) {
      if (Array.isArray(actors)) write(actors);
    },
    cacheActor(actor) {
      if (actor) write([actor]);
    },
  };
}

/** {@link ActorWriter.cacheActors} into the signed-in account now, for an answer in hand. */
export function cacheActors(actors: readonly CacheableUser[] | null | undefined): void {
  actorWriter().cacheActors(actors);
}

/** {@link ActorWriter.cacheActor} into the signed-in account now, for an answer in hand. */
export function cacheActor(actor: CacheableUser | null | undefined): void {
  actorWriter().cacheActor(actor);
}

/**
 * Record that a profile edit landed, and tell every cache holding a copy of that
 * identity. Call this only after the server has accepted the write: a failed
 * edit leaves every surface exactly as the caches already have it.
 *
 * `options.cleared` names the fields the write deliberately EMPTIED, and it is
 * the only way a clear can propagate at all: the response omits a cleared scalar
 * exactly as it omits one the write never touched, so nothing downstream can
 * tell them apart from the payload. The SDK owns both the semantics and the
 * closed list of fields this may name (`CLEARABLE_USER_FIELDS`) — derive the
 * list at the call site with the helper matching the write that was performed
 * (`clearedFieldsFromAccountUpdate` for `updateAccount`,
 * `clearedFieldsFromProfileUpdate` for `updateProfile`), because the write INPUT
 * is the only place the intent exists.
 */
export function noteIdentityChanged(
  update: IdentityUpdate,
  viewerId?: string,
  options?: UpsertCachedUserOptions,
): void {
  // An edit accepted for an account that is no longer signed in reaches
  // nothing of the account that is.
  if (viewerId !== undefined && viewerId !== currentAccountId()) return;
  const stored = recordIdentityChange(update);
  if (!stored) return;

  // The SDK's `User` is indexed by id and by username and merges rather than
  // replaces — so the profile screen, the hover card and every `useUserById`
  // card get the edit without losing the counts and viewer relationship an
  // authoritative profile fetch had already stored. Not routed through
  // `cacheActor`: this is the authority for that identity, so it must not be
  // reconciled against itself.
  storeUsers(stored, options);

  // The operated-accounts list embeds each account's profile and feeds the
  // channels screen, the composer's publish-as picker and the channel settings
  // screen itself. It is a list of accounts rather than an actor cache, so the
  // upsert above cannot reach it.
  void queryClient.invalidateQueries({
    predicate: (query) => viewerQueryKeys.isOperatedAccounts(query.queryKey),
  });
}
