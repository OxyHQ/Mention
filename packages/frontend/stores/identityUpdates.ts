import { useCallback, useSyncExternalStore } from 'react';
import type { PostUser } from '@mention/shared-types';

/**
 * The single authority for "a profile edit changed an identity that other
 * surfaces are holding their own copy of".
 *
 * The write class this owns is a person's or a channel's IDENTITY — the display
 * name, the handle and the picture. Today one screen performs it
 * (`app/(app)/c/[username]/settings.tsx`, the only door a channel's profile
 * has), but nothing here is channel-specific: an identity is an identity.
 *
 * It sits beside `stores/engagementInvalidation` and `stores/laneInvalidation`,
 * which own the other two write classes, and it exists for the same reason they
 * do — Mention holds one fact in several caches that cannot see each other, so a
 * write has to speak to all of them from ONE place or they drift. Read
 * `engagementInvalidation`'s docstring for that seam; this file only records
 * where an identity DIFFERS from a list membership, because the difference
 * decides the whole design.
 *
 * **The SERVER is not the problem, and checking that first is what makes the
 * rest of this the right shape.** oxy-api publishes `oxy:user:invalidate` on the
 * account write and Mention's backend drops its identity caches on receipt
 * (`packages/backend/src/services/userInvalidationSubscriber.ts`), so a fresh
 * ASK returns the new picture almost immediately. Delivery is at-most-once by
 * design and degrades to the `usersummary:v5:<id>` TTL (ten minutes) if the
 * message is lost, but that is the degraded case, not the normal one. Reloading
 * the page therefore shows the edit — which is precisely the observation that
 * locates the bug on this side of the wire.
 *
 * What has no signal is the copies the CLIENT IS ALREADY HOLDING, and none of
 * them re-ask:
 *
 *   * the React Query user entry. The write merges into it but leaves its
 *     freshness alone (that is `upsertCachedUser`'s contract for an existing
 *     entry), and `useUserByUsername` pairs a five-minute `staleTime` with
 *     `refetchOnMount: true`, which deliberately does NOT refetch an entry that
 *     is still fresh.
 *   * every `post.user` already embedded in a rendered post — in the feed
 *     store's retained slice and in SQLite. Nothing rewrites those, and a
 *     remount warm-starts from the retained slice rather than refetching page 1.
 *
 * A full reload is the only thing that discards all of them at once, which is
 * exactly why one appeared to be required.
 *
 * **And the write is actively undone.** Every feed response is fed through
 * `lib/precacheActorsFromPosts` into the SDK's user cache, and that merge
 * overrides a real value with a real value — so a response whose authors were
 * hydrated before the invalidation landed puts the pre-edit picture straight
 * back over what this write stored. On a channel's own page every post in that
 * response is authored by the account whose picture just changed, so the header
 * is decided by a race it should not be in.
 *
 * Hence an OVERLAY rather than an invalidation: the edit is recorded here, and
 * a server copy that still predates it is corrected on its way in
 * (`applyKnownIdentity`) instead of being allowed to win. Two consumers, and
 * between them they cover both caches:
 *
 *   * React Query — `lib/actorCache.ts` is the one door into the SDK's user
 *     cache, so the edit is written through there and every incoming actor is
 *     corrected there, wherever the surface that fetched it lives.
 *   * The post rows themselves — `components/Feed/PostItem.tsx` resolves its
 *     author through {@link useKnownIdentity}, so a feed row, a post detail, a
 *     quote card and a boosted original all correct themselves wherever their
 *     copy of the post came from (SQLite, the memory-mode slice, or a response
 *     that has not landed yet).
 *
 * **This module holds STATE ONLY — no query client, no SDK.** It is imported by
 * `PostItem`, so it is in the module graph of every screen that renders a post
 * and of every test that renders one; pulling the SDK barrel in through here
 * puts it in all of them too. That is not hypothetical tidiness: it broke a
 * sibling's `PostItem` suite the first time this file imported it. The write
 * side lives in `lib/actorCache.ts`, which may depend on this and not the other
 * way round.
 *
 * **An entry retires itself.** It is not a permanent override — it is a bridge
 * over the window in which a hydrated copy still predates the edit, so it is
 * dropped the moment one AGREES with it ({@link reconcileKnownIdentities},
 * called from the same ingestion point). With the server-side invalidation above
 * that is usually the very next page, which is the point: no clock and no TTL to
 * keep in step with a backend constant, and an identity changed somewhere else —
 * another device, accounts.oxy.so — is never pinned to a value this session
 * happened to write.
 */

/** The canonical structured name, as it rides on every post author. */
type IdentityName = PostUser['name'];

/**
 * The identity fields a profile edit can change, and the only fields this module
 * ever writes. Everything else about a user — counts, viewer relationship,
 * joined date — is owned by whichever cache holds it and is never touched here.
 */
/**
 * A type alias rather than an interface on purpose: only an alias gets TypeScript's
 * implicit index signature, and without it this is not assignable to the SDK's
 * `CacheableUser` — which is where every recorded edit is handed next.
 */
export type IdentityUpdate = {
  id: string;
  username?: string;
  name?: IdentityName;
  avatar?: string | null;
};

/**
 * Any actor-shaped object whose identity can be corrected. `name` admits the
 * plain string spelling as well, because the SDK's cache boundary
 * (`CacheableUser`) accepts a bare display string from the looser actor objects
 * — the overlay only ever writes the canonical object shape, so widening the
 * constraint costs nothing and lets one function serve both boundaries.
 */
type IdentityHolder = {
  id?: string;
  username?: string;
  name?: IdentityName | string;
  avatar?: string | null;
};

/** Recorded identities, keyed by Oxy user id. */
const knownIdentities = new Map<string, IdentityUpdate>();

type IdentityListener = () => void;

const listeners = new Set<IdentityListener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Only the fields the edit actually carried. A field the write did not mention
 * must not be recorded, or the overlay would pin whatever the writer happened to
 * be holding — and, worse, would then "agree" with a server copy on a value
 * nobody edited.
 *
 * Empty and cleared values are dropped rather than recorded, which mirrors the
 * SDK's own merge (`upsertCachedUser` never lets a degraded value overwrite a
 * good one) so identity resolves under ONE rule everywhere instead of two that
 * disagree at the edges. The cost is that CLEARING a picture does not appear
 * instantly — it takes the same path it takes today — and that limit belongs to
 * the SDK's merge contract rather than to this file.
 */
function meaningfulFields(update: IdentityUpdate): Omit<IdentityUpdate, 'id'> {
  const fields: Omit<IdentityUpdate, 'id'> = {};
  if (update.username && update.username.trim() !== '') {
    fields.username = update.username;
  }
  if (update.name?.displayName && update.name.displayName.trim() !== '') {
    fields.name = update.name;
  }
  if (update.avatar && update.avatar.trim() !== '') {
    fields.avatar = update.avatar;
  }
  return fields;
}

/** Whether an incoming actor already carries everything a recorded entry holds. */
function serverAgrees(entry: IdentityUpdate, actor: IdentityHolder): boolean {
  if (entry.username !== undefined && actor.username !== entry.username) return false;
  if (entry.avatar !== undefined && actor.avatar !== entry.avatar) return false;
  if (entry.name !== undefined) {
    const incoming = typeof actor.name === 'string' ? actor.name : actor.name?.displayName;
    if (incoming !== entry.name.displayName) return false;
  }
  return true;
}

/**
 * The identity recorded for a user, or `undefined` when nothing has been.
 *
 * The returned object is stable by reference until the next write for that user,
 * which is what lets {@link useKnownIdentity} hand it to `useSyncExternalStore`
 * directly.
 */
export function getKnownIdentity(userId: string | undefined): IdentityUpdate | undefined {
  return userId ? knownIdentities.get(userId) : undefined;
}

/**
 * Correct one actor with an already-read entry. PURE — a function of its two
 * arguments and nothing else, so a render may call it inside a `useMemo` without
 * reading module state from a memoized position (the React Compiler rule in
 * `~/AGENTS.md`); {@link useKnownIdentity} does the reading, through the store's
 * own subscription.
 *
 * Returns the SAME reference when there is nothing recorded — the common case by
 * far — so a hot path never allocates a new object per row.
 */
export function mergeKnownIdentity<T extends IdentityHolder>(
  actor: T,
  entry: IdentityUpdate | undefined,
): T {
  if (!entry) return actor;
  const { id: _id, ...fields } = entry;
  return { ...actor, ...fields };
}

/**
 * Correct one actor against what this session knows about it. For ingestion
 * paths, which have no render to subscribe from.
 */
export function applyKnownIdentity<T extends IdentityHolder>(actor: T): T {
  return mergeKnownIdentity(actor, getKnownIdentity(actor.id));
}

/**
 * Reactive read of the identity recorded for one user.
 *
 * `useSyncExternalStore` rather than a `useMemo` over the map, for the reason
 * `usePostSelector` uses it over the SQLite cache: the map is external mutable
 * state, and the React Compiler freezes the first value read from one inside a
 * memoized position. The snapshot is the stored entry itself, which is stable by
 * reference until that user is written again — the contract
 * `useSyncExternalStore` requires — and is `undefined` for every user nobody has
 * edited, so a feed full of rows subscribes to a store that hands them all the
 * same nothing and never re-renders them.
 */
export function useKnownIdentity(userId: string | undefined): IdentityUpdate | undefined {
  const getSnapshot = useCallback(() => getKnownIdentity(userId), [userId]);
  return useSyncExternalStore(subscribeToIdentityUpdates, getSnapshot, getSnapshot);
}

/**
 * Drop every recorded identity that the incoming actors now agree with.
 *
 * Called with each batch of server-hydrated authors, which is exactly the moment
 * the question can be answered: the overlay exists to cover the window in which
 * post hydration still carries the old value, so it has done its job as soon as
 * hydration carries the new one. One Oxy account is one Redis entry, so
 * agreement is all-or-nothing per user rather than per field.
 */
export function reconcileKnownIdentities(actors: readonly IdentityHolder[]): void {
  if (knownIdentities.size === 0) return;
  let retired = false;
  for (const actor of actors) {
    const entry = getKnownIdentity(actor.id);
    if (entry && serverAgrees(entry, actor)) {
      knownIdentities.delete(entry.id);
      retired = true;
    }
  }
  if (retired) notify();
}

/**
 * Subscribe to identity changes. Returns an unsubscribe function.
 *
 * Exported for {@link useKnownIdentity}; a component should use the hook rather
 * than subscribing by hand.
 */
export function subscribeToIdentityUpdates(listener: IdentityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record a profile edit in the overlay and return exactly what was stored.
 *
 * STATE ONLY, and not the entry point: a recorded edit that no cache is told
 * about corrects the rows that happen to re-render and nothing else. Call
 * `noteIdentityChanged` in `lib/actorCache.ts`, which does this and the cache
 * writes together. It is separate solely so this module can stay free of the SDK
 * (see the note at the top), which is why it is the only caller.
 *
 * Returns `null` for an id-less write — there is nothing to key it on.
 */
export function recordIdentityChange(update: IdentityUpdate): IdentityUpdate | null {
  if (!update.id) return null;
  const stored: IdentityUpdate = { id: update.id, ...meaningfulFields(update) };
  knownIdentities.set(update.id, stored);
  notify();
  return stored;
}

/**
 * Drop every recorded identity. For tests.
 *
 * Deliberately NOT wired into the account switch, unlike the reset of every
 * store beside it: a channel's picture is the same picture whoever is signed in,
 * so what is recorded here stays TRUE across a switch — and the switch clears
 * the caches that hold the stale copy, which is precisely when a correction is
 * most needed (an operator changing a channel's picture and then switching into
 * that channel is one flow, not two). Entries retire against the server rather
 * than against a session.
 */
export function resetIdentityUpdates(): void {
  knownIdentities.clear();
  notify();
}
