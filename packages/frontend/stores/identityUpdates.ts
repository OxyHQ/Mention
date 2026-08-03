import { useSyncExternalStore } from 'react';
import type { PostUser } from '@mention/shared-types';
// Type-only, and it has to stay that way: this module is in `PostItem`'s graph
// (see below), so a runtime edge from here reaches every screen that renders a
// post. An erased import costs nothing and keeps the id union the one Oxy owns.
import type { AccountCategoryId } from '@oxyhq/contracts';

/**
 * The single authority for "a profile edit changed an identity that other
 * surfaces are holding their own copy of".
 *
 * The write class this owns is a person's or a channel's IDENTITY — the display
 * name, the handle, the picture, the bio and the categories. Today one screen
 * performs it (`app/(app)/c/[username]/settings.tsx`, the only door a channel's
 * profile has), but nothing here is channel-specific: an identity is an
 * identity.
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
 *     actors through {@link useKnownIdentities}, so a feed row, a post detail, a
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
 *
 * THE one place the set is decided, which is what lets a caller hand over the
 * whole account the server returned rather than a payload it assembled: an Oxy
 * `User` is a superset of this, and {@link recordIdentityChange} PICKS, so a
 * field added here is already being supplied by every existing call site. The
 * opposite arrangement — each site listing the fields it thinks matter — is how
 * the description came to be missing while type-checking clean.
 *
 * A type alias rather than an interface on purpose: only an alias gets
 * TypeScript's implicit index signature, and without it this is not assignable
 * to the SDK's `CacheableUser` — which is where every recorded edit is handed
 * next.
 */
export type IdentityUpdate = {
  id: string;
  username?: string;
  name?: IdentityName;
  avatar?: string | null;
  /**
   * The account's description. It rides only SOME of the surfaces below — a
   * recommendation, a similar-accounts card and a followers list all carry one,
   * while a post author never does (`PostUser` has no bio, because no post
   * renders one). That asymmetry is what {@link reconcileKnownIdentities} is
   * built around, and it is the whole reason retirement is per-field.
   */
  bio?: string;
  /**
   * What the account IS, as an ORDERED list of ids whose element 0 is the
   * primary. Ordered, so agreement below is positional — a reordering IS the
   * edit that makes a different category primary, and a set-wise comparison
   * would call it no change at all.
   *
   * Unanswerable on every surface that exists today, exactly like the bio and
   * for the same reason: nothing embedded in a post carries one.
   */
  accountCategories?: readonly AccountCategoryId[];
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
  bio?: string | null;
  accountCategories?: readonly string[];
};

/**
 * Recorded identities, keyed by Oxy user id.
 *
 * COPY-ON-WRITE, and that is what lets a render subscribe to the whole map
 * instead of one id at a time. A row shows several actors — its author, whoever
 * reposted it, each collaborator on the byline — and a hook cannot be called per
 * element of an array, so the snapshot has to be the map itself; mutating one in
 * place would hand `useSyncExternalStore` an unchanged reference after a write
 * and nothing would repaint. Replacing it means the reference changes exactly
 * when the contents do.
 *
 * Nothing is recorded in the overwhelming majority of sessions, so this stays
 * the one shared {@link EMPTY} instance and no subscriber ever re-renders.
 */
const EMPTY: ReadonlyMap<string, IdentityUpdate> = new Map();

let knownIdentities: ReadonlyMap<string, IdentityUpdate> = EMPTY;

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
 * disagree at the edges.
 *
 * The cost is that a CLEAR is invisible here: an emptied bio or picture reads
 * exactly like a field this write did not carry, and telling them apart needs
 * the one thing the payload does not hold — what the writer intended. The SDK
 * takes that as a DECLARATION from the call site instead
 * (`upsertCachedUser(…, { cleared })`, bounded to its own closed
 * `CLEARABLE_USER_FIELDS`), which `noteIdentityChanged` passes straight through,
 * so a clear does reach the React Query user entry. What it does not reach is
 * the overlay: an actor cannot express "this field is empty" distinguishably
 * from "I do not carry it", so a recorded clear could never be retired against
 * one and would pin an emptied field for the whole session. A clear therefore
 * still takes the ordinary path through the post rows.
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
  if (update.bio && update.bio.trim() !== '') {
    fields.bio = update.bio;
  }
  if (update.accountCategories && update.accountCategories.length > 0) {
    fields.accountCategories = update.accountCategories;
  }
  return fields;
}

/**
 * What one incoming actor says about ONE recorded field.
 *
 * `unanswerable` is the case the whole rule turns on, and it is not the same as
 * disagreement: an actor that does not carry the field at all has said nothing
 * about it. A post author carries no bio — not an empty one, none — so treating
 * its silence as a mismatch would pin every OTHER field of that entry forever,
 * and treating it as agreement would retire a correction nothing has confirmed.
 */
type FieldVerdict = 'unrecorded' | 'agrees' | 'differs' | 'unanswerable';

function fieldVerdict(
  recorded: string | null | undefined,
  carried: string | null | undefined,
): FieldVerdict {
  if (recorded === undefined) return 'unrecorded';
  if (carried === undefined) return 'unanswerable';
  return carried === recorded ? 'agrees' : 'differs';
}

/**
 * {@link fieldVerdict} for the ordered category list. Positional, because the
 * order carries the primary; a set comparison would read a promotion as no
 * change. Written here rather than through `utils/accountCategories`'
 * `accountCategoriesEqual` because that module imports `@oxyhq/contracts` at
 * RUNTIME, which is the one thing this file may not pull into `PostItem`'s
 * graph.
 */
function listVerdict(
  recorded: readonly string[] | undefined,
  carried: readonly string[] | undefined,
): FieldVerdict {
  if (recorded === undefined) return 'unrecorded';
  if (carried === undefined) return 'unanswerable';
  const same =
    recorded.length === carried.length && recorded.every((id, index) => carried[index] === id);
  return same ? 'agrees' : 'differs';
}

/**
 * The recorded fields still outstanding after an incoming actor has spoken, or
 * `null` when it changes nothing — the overwhelming majority of actors, and the
 * cheap way to leave the map alone.
 *
 * A field retires only on POSITIVE agreement, and only when every OTHER field
 * the same actor could answer for agrees too. That second condition is what
 * keeps a lagging field protecting the rest: an actor carrying the new picture
 * beside a stale display name has not caught up, whatever the picture says, so
 * neither is retired and both keep correcting. Fields it could not answer for
 * are simply carried forward.
 */
function unconfirmedFields(
  entry: IdentityUpdate,
  actor: IdentityHolder,
): Omit<IdentityUpdate, 'id'> | null {
  const carriedName = typeof actor.name === 'string' ? actor.name : actor.name?.displayName;
  const username = fieldVerdict(entry.username, actor.username);
  const avatar = fieldVerdict(entry.avatar, actor.avatar);
  const bio = fieldVerdict(entry.bio, actor.bio);
  const name = fieldVerdict(entry.name?.displayName, carriedName);
  const categories = listVerdict(entry.accountCategories, actor.accountCategories);

  const verdicts = [username, avatar, bio, name, categories];
  if (verdicts.includes('differs') || !verdicts.includes('agrees')) return null;

  const remaining: Omit<IdentityUpdate, 'id'> = {};
  if (username === 'unanswerable') remaining.username = entry.username;
  if (avatar === 'unanswerable') remaining.avatar = entry.avatar;
  if (bio === 'unanswerable') remaining.bio = entry.bio;
  if (name === 'unanswerable') remaining.name = entry.name;
  if (categories === 'unanswerable') remaining.accountCategories = entry.accountCategories;
  return remaining;
}

/**
 * The identity recorded for a user, or `undefined` when nothing has been.
 *
 * The returned object is stable by reference until the next write for that user
 * or until one of its fields retires, which is what lets {@link useKnownIdentities}
 * hand the map to `useSyncExternalStore` directly.
 */
export function getKnownIdentity(userId: string | undefined): IdentityUpdate | undefined {
  return userId ? knownIdentities.get(userId) : undefined;
}

/** Every recorded identity. Stable by reference until one is written or a field of one retires. */
export function getKnownIdentities(): ReadonlyMap<string, IdentityUpdate> {
  return knownIdentities;
}

/**
 * Correct one actor with an already-read entry. PURE — a function of its two
 * arguments and nothing else, so a render may call it inside a `useMemo` without
 * reading module state from a memoized position (the React Compiler rule in
 * `~/AGENTS.md`); {@link useKnownIdentities} does the reading, through the store's
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
 * Reactive read of every recorded identity.
 *
 * `useSyncExternalStore` rather than a `useMemo` over the map, for the reason
 * `usePostSelector` uses it over the SQLite cache: the map is external mutable
 * state, and the React Compiler freezes the first value read from one inside a
 * memoized position. Feeding the returned map to {@link mergeKnownIdentity}
 * inside a `useMemo` is fine — it is then an ARGUMENT, and the merge is pure.
 *
 * The whole map rather than one id, because a row shows several actors and a
 * hook cannot be called per element of an array. It costs nothing while nothing
 * is recorded (one shared empty instance, so no subscriber re-renders), and a
 * profile edit is rare enough that repainting the mounted rows once is the right
 * trade against a subscription per actor per row.
 */
export function useKnownIdentities(): ReadonlyMap<string, IdentityUpdate> {
  return useSyncExternalStore(
    subscribeToIdentityUpdates,
    getKnownIdentities,
    getKnownIdentities,
  );
}

/**
 * Drop every recorded FIELD that the incoming actors now agree with, and the
 * entry itself once nothing is left outstanding.
 *
 * Called with each batch of server-hydrated actors, which is exactly the moment
 * the question can be answered: the overlay exists to cover the window in which
 * hydration still carries the old value, so it has done its job as soon as
 * hydration carries the new one.
 *
 * **Per FIELD, and only over the fields the actor can ANSWER for.** Retirement
 * used to be all-or-nothing across the whole entry, on the reasoning that one
 * Oxy account is one server cache entry — so an actor agreeing about everything
 * recorded proved that entry had been refreshed. That reasoning survives here
 * unchanged (a single `differs` still retires nothing at all); what it cannot
 * survive is a recorded field NO post carries. `bio` is one: `PostUser` has
 * none, because no post renders one.
 *
 * Both simpler rules fail, in opposite directions. Demand agreement about every
 * recorded field and an entry holding a bio can never be retired by a feed — so
 * the picture and the name it also holds stay pinned for the whole session.
 * Retire each field on its own agreement and an UNCHANGED field, which agrees
 * with anything, retires instantly: an edit that touched only the bio would drop
 * its handle/name/picture guard on the first page, and — worse — a stale name
 * beside a fresh picture would no longer be the proof that the server is behind.
 * Answerability separates the two: silence is not evidence, so it neither
 * retires a field nor blocks anything else from retiring.
 */
export function reconcileKnownIdentities(actors: readonly IdentityHolder[]): void {
  if (knownIdentities.size === 0) return;
  let next: Map<string, IdentityUpdate> | null = null;
  for (const actor of actors) {
    const id = actor.id;
    if (!id) continue;
    const entry = (next ?? knownIdentities).get(id);
    if (!entry) continue;
    const remaining = unconfirmedFields(entry, actor);
    if (!remaining) continue;
    next ??= new Map(knownIdentities);
    if (Object.keys(remaining).length === 0) next.delete(id);
    else next.set(id, { id, ...remaining });
  }
  if (!next) return;
  knownIdentities = next.size === 0 ? EMPTY : next;
  notify();
}

/**
 * Subscribe to identity changes. Returns an unsubscribe function.
 *
 * Exported for {@link useKnownIdentities}; a component should use the hook rather
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
 *
 * A write carrying no meaningful field at all (everything it touched was
 * cleared) is still RETURNED, so the caller can hand it to the caches, but it is
 * not recorded: an entry with no fields corrects nothing, and — since a field is
 * what {@link reconcileKnownIdentities} retires against — nothing would ever
 * retire it. Every recorded entry holding at least one field is the invariant
 * that makes per-field retirement terminate.
 */
export function recordIdentityChange(update: IdentityUpdate): IdentityUpdate | null {
  if (!update.id) return null;
  const fields = meaningfulFields(update);
  const stored: IdentityUpdate = { id: update.id, ...fields };
  if (Object.keys(fields).length === 0) return stored;
  const next = new Map(knownIdentities);
  next.set(update.id, stored);
  knownIdentities = next;
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
  knownIdentities = EMPTY;
  notify();
}
