/**
 * The single definition of "this post is a reply".
 *
 * WHY THIS EXISTS
 * ---------------
 * A post's parent is recorded in TWO places, and they are not interchangeable:
 *
 *   - `parentPostId` — an ObjectId reference to the parent's LOCAL document. It
 *     is the join the thread UI needs, and it exists only once the parent is in
 *     our own `posts` collection.
 *   - `federation.inReplyTo` — the AP `inReplyTo` IRI carried by a federated
 *     Note. It is written at ingest and never depends on us holding the parent.
 *
 * For a locally-authored reply the two always agree. For a FEDERATED reply they
 * can diverge: the outbox connector links the reply into its thread only if
 * `resolveThreadLink` can resolve — or bounded-backfill — the parent
 * (`outbox.service.ts`, `if (!link) continue`). When the parent is unreachable
 * (remote 404, deleted post, defederated or authorized-fetch instance, or the
 * backfill depth cap), the reply is stored with its `federation.inReplyTo`
 * intact and `parentPostId` left null.
 *
 * Reading `parentPostId == null` as "not a reply" therefore silently
 * misclassifies exactly those posts, and it did so in both directions:
 *
 *   - Discovery lanes (trending, explore, rising creators, popular-with-friends)
 *     exclude replies with a `parentPostId` null check, so an unlinked federated
 *     reply passed the filter and was ranked into For You as if it were a thread
 *     root. It then reached the slicer, which asked the same question the same
 *     way, found no parent, and emitted a bare single-post slice — rendering a
 *     context-free reply ("@someone thank you!") as an ordinary top-level post.
 *   - Reply lanes (`onlyReplies`, replies-from-follows, top replies, the profile
 *     Replies tab) MISSED those same posts, because to them the reply did not
 *     exist.
 *
 * The fix is not to widen or narrow any one of those queries: it is to have ONE
 * definition of the concept that every call site — Mongo query and in-memory
 * predicate alike — is built from. A post is a reply when it has a parent, and
 * having a parent means either encoding is present.
 *
 * {@link isReplyClause} and {@link notAReplyClause} are exact De Morgan duals by
 * construction (`$nin`/`$in` over the same `[null, '']` sentinel set), so no
 * document can ever satisfy both or neither. {@link isReplyPost} is the same
 * predicate for candidates already in memory. Any new site that needs to ask
 * this question must use one of the three rather than re-deriving it.
 *
 * MONGO SEMANTICS worth stating, because both are easy to get wrong:
 *   - `{ field: null }` matches a null value AND a missing field, so the
 *     `$exists: false` arm the old clauses carried was always redundant.
 *   - `{ field: { $ne: null } }` conversely matches only documents where the
 *     field is present and non-null — a missing field is treated as null and
 *     excluded.
 * The `''` sentinel is carried alongside `null` so an empty stored IRI can never
 * be read as a parent; `extractInReplyToUri` should never produce one, and this
 * makes that assumption non-load-bearing.
 */

/** The values of a parent reference that mean "there is no parent". */
const ABSENT_PARENT = [null, ''];

/** The `federation.inReplyTo` path, spelled once. */
const FEDERATION_IN_REPLY_TO = 'federation.inReplyTo';

/**
 * The minimal shape {@link isReplyPost} reads. Deliberately structural: feed
 * candidates, lean documents and hydrated posts all satisfy it, and none of them
 * needs to be imported here.
 */
export interface ReplyLinkFields {
  parentPostId?: unknown;
  federation?: { inReplyTo?: unknown } | null;
}

/**
 * Mongo clause selecting posts that ARE replies — locally linked or known only
 * by their federated `inReplyTo` IRI.
 *
 * Returned fresh on every call: callers spread it into larger match objects and
 * a shared frozen literal would invite accidental mutation.
 */
export function isReplyClause(): Record<string, unknown> {
  return {
    $or: [
      { parentPostId: { $ne: null } },
      { [FEDERATION_IN_REPLY_TO]: { $nin: ABSENT_PARENT } },
    ],
  };
}

/**
 * Mongo clause selecting posts that are NOT replies (thread roots).
 *
 * Two plain keys rather than an `$and` of `$or`s: `{ field: null }` already
 * covers "null or missing", so this needs no disjunction at all and stays a
 * cheap conjunctive filter.
 */
export function notAReplyClause(): Record<string, unknown> {
  return {
    parentPostId: null,
    [FEDERATION_IN_REPLY_TO]: { $in: ABSENT_PARENT },
  };
}

/**
 * Append a reply constraint to a query already under construction.
 *
 * Both clauses go through `$and` rather than being assigned onto the query
 * directly: {@link isReplyClause} is an `$or`, and a bare `query.$or = …` would
 * silently CLOBBER any disjunction the caller had already put there (label
 * filters, authorship matches, cursor windows). Appending preserves whatever is
 * present and composes with a later call.
 */
function appendReplyConstraint(query: Record<string, unknown>, clause: Record<string, unknown>): void {
  const existing = query.$and;
  query.$and = Array.isArray(existing) ? [...existing, clause] : [clause];
}

/** Constrain an in-progress query to replies only. */
export function restrictToReplies(query: Record<string, unknown>): void {
  appendReplyConstraint(query, isReplyClause());
}

/** Constrain an in-progress query to thread roots only (no replies). */
export function restrictToRoots(query: Record<string, unknown>): void {
  appendReplyConstraint(query, notAReplyClause());
}

/**
 * In-memory counterpart of {@link isReplyClause} — the predicate the feed
 * engine's filter modules apply to candidates that are already loaded.
 */
export function isReplyPost(post: ReplyLinkFields): boolean {
  if (post.parentPostId !== null && post.parentPostId !== undefined) {
    return true;
  }
  const inReplyTo = post.federation?.inReplyTo;
  return typeof inReplyTo === 'string' && inReplyTo.length > 0;
}
