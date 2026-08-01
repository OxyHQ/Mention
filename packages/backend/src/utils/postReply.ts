/**
 * The single definition of "this post is a reply".
 *
 * WHY THIS EXISTS
 * ---------------
 * A post's parent is recorded in TWO places, and they are not interchangeable:
 *
 *   - `parent_post_id` — a reference to the parent's LOCAL row. It is the join
 *     the thread UI needs, and it exists only once the parent is in our own
 *     `posts` table.
 *   - `federation_in_reply_to` — the AP `inReplyTo` IRI carried by a federated
 *     Note. It is written at ingest and never depends on us holding the parent.
 *
 * For a locally-authored reply the two always agree. For a FEDERATED reply they
 * can diverge: the outbox connector links the reply into its thread only if
 * `resolveThreadLink` can resolve — or bounded-backfill — the parent
 * (`outbox.service.ts`, `if (!link) continue`). When the parent is unreachable
 * (remote 404, deleted post, defederated or authorized-fetch instance, or the
 * backfill depth cap), the reply is stored with its `federation_in_reply_to`
 * intact and `parent_post_id` left null.
 *
 * Reading `parent_post_id IS NULL` as "not a reply" therefore silently
 * misclassifies exactly those posts, and it did so in both directions:
 *
 *   - Discovery lanes (trending, explore, rising creators, popular-with-friends)
 *     exclude replies with a `parent_post_id` null check, so an unlinked
 *     federated reply passed the filter and was ranked into For You as if it
 *     were a thread root. It then reached the slicer, which asked the same
 *     question the same way, found no parent, and emitted a bare single-post
 *     slice — rendering a context-free reply ("@someone thank you!") as an
 *     ordinary top-level post.
 *   - Reply lanes (`onlyReplies`, replies-from-follows, top replies, the profile
 *     Replies tab) MISSED those same posts, because to them the reply did not
 *     exist.
 *
 * The fix is not to widen or narrow any one of those queries: it is to have ONE
 * definition of the concept that every call site — SQL predicate and in-memory
 * predicate alike — is built from. A post is a reply when it has a parent, and
 * having a parent means either encoding is present.
 *
 * {@link isReplySql} and {@link notAReplySql} are exact De Morgan duals by
 * construction, so no row can satisfy both or neither. {@link isReplyPost} is
 * the same predicate for candidates already in memory. Any new site that needs
 * to ask this question must use one of the three rather than re-deriving it.
 *
 * ## ESCALATED — `parent_post_id` alone stops being sufficient under `SET NULL`
 *
 * `posts.parent_post_id` is declared `ON DELETE SET NULL` (see
 * `db/schema/posts.ts` and `CONVENTIONS.md`). Mongo left an orphaned reply
 * pointing at a dead id, so `parent_post_id != null` kept it out of root feeds
 * forever. Postgres NULLs it, so the reply satisfies the FIRST conjunct here.
 *
 * That is NOT automatically a promotion, and the distinction matters:
 *
 *   - A FEDERATED orphan still carries `federation_in_reply_to`, so the SECOND
 *     conjunct still excludes it. Unaffected.
 *   - A LOCAL orphan carries neither. It IS promoted into For You / Following /
 *     Explore as a root post — a real behaviour change from Mongo.
 *
 * The residual exposure is therefore local replies whose parent was deleted, not
 * "every orphaned reply". Closing it needs an explicit discriminator (a stored
 * "this was authored as a reply" fact that survives the parent's deletion), which
 * is a SCHEMA decision and is deliberately NOT invented here — a second,
 * competing discriminator would be worse than the gap. `postReply.test.ts` pins
 * the current behaviour in both directions so the day a discriminator lands, the
 * characterization test goes red and names this file.
 *
 * SQL SEMANTICS worth stating, because both are easy to get wrong:
 *   - `x IS NULL` and `x IS NOT NULL` are total: they never return NULL, so a
 *     row is never silently dropped by three-valued logic.
 *   - `x <> ''` IS NULL when `x` is NULL, which is why {@link isReplySql} guards
 *     it with `IS NOT NULL` rather than relying on `<>` alone. `FALSE AND NULL`
 *     is FALSE, so the guarded form is total; the unguarded form is not.
 * The `''` sentinel is carried alongside NULL so an empty stored IRI can never
 * be read as a parent; `extractInReplyToUri` should never produce one, and this
 * makes that assumption non-load-bearing.
 */

import { sql, type SQL } from 'drizzle-orm';
import { posts } from '../db/schema';

/**
 * The minimal shape {@link isReplyPost} reads. Deliberately structural: feed
 * candidates, assembled rows and hydrated posts all satisfy it, and none of them
 * needs to be imported here.
 */
export interface ReplyLinkFields {
  parentPostId?: unknown;
  federation?: { inReplyTo?: unknown } | null;
}

/**
 * SQL predicate selecting posts that ARE replies — locally linked or known only
 * by their federated `inReplyTo` IRI.
 *
 * Composed with `and(...)` at the call site. Unlike the Mongo original there is
 * no `$and`-appending helper, because there is nothing to clobber: drizzle
 * conditions are values, not keys on a shared mutable object, so the entire
 * `restrictToReplies` / `appendReplyConstraint` machinery that existed to stop a
 * later `$or` assignment from silently dropping this constraint has no analogue
 * and is deleted rather than transliterated.
 */
export function isReplySql(): SQL {
  return sql`(
    ${posts.parentPostId} is not null
    or (${posts.federationInReplyTo} is not null and ${posts.federationInReplyTo} <> '')
  )`;
}

/**
 * SQL predicate selecting posts that are NOT replies (thread roots).
 *
 * The exact De Morgan dual of {@link isReplySql}:
 * `¬(A ∨ B) = ¬A ∧ ¬B`, where `¬(x IS NOT NULL AND x <> '')` is
 * `x IS NULL OR x = ''`.
 */
export function notAReplySql(): SQL {
  return sql`(
    ${posts.parentPostId} is null
    and (${posts.federationInReplyTo} is null or ${posts.federationInReplyTo} = '')
  )`;
}

/**
 * In-memory counterpart of {@link isReplySql} — the predicate the feed engine's
 * filter modules apply to candidates that are already loaded.
 */
export function isReplyPost(post: ReplyLinkFields): boolean {
  if (post.parentPostId !== null && post.parentPostId !== undefined) {
    return true;
  }
  const inReplyTo = post.federation?.inReplyTo;
  return typeof inReplyTo === 'string' && inReplyTo.length > 0;
}
