import { Router, Request, Response } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { activityPubConnector } from '../ActivityPubConnector';
import { AP_CONTEXT } from '@oxyhq/federation';
import { getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { findPostRecords, loadPostRecord } from '../../../db/posts/postRepository';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  AP_CONTENT_TYPE,
  isActivityPubAccept,
  outboxUrl,
  featuredUrl,
  resolveOxyUser,
} from '../constants';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../../../mtn/feed/CursorBuilder';
import { isFediverseSharingEnabledFromUser } from '../../../services/fediverseSharing';

/**
 * The CONTENT half of the `/ap/users/:username/*` namespace: the outbox, the
 * `featured` (pinned) collection, and per-post dereference. These build AP `Note`s
 * from the `Post` model, so they stay in Mention; the engine (`engine.routes.ts`)
 * owns the actor doc, the inbox, and the follower/following collections on the SAME
 * `/ap` prefix. The AP rate limiter is applied once at the `/ap` mount in
 * `app.ts`, covering this router and the engine router alike.
 */
const router = Router();

/** Content negotiation: check if the request wants ActivityPub JSON-LD. */
function wantsActivityPub(req: Request): boolean {
  return isActivityPubAccept(req.headers.accept);
}

/** Extract username param safely as a string. */
function getUsername(req: Request): string {
  const val = req.params.username;
  return typeof val === 'string' ? val : Array.isArray(val) ? val[0] : String(val);
}

/**
 * What a user's outbox and `featured` collection publish: their own public,
 * published, ROOT posts.
 *
 * `is_reply = false`, NOT `parent_post_id IS NULL`, and the difference is
 * user-visible. `parent_post_id` is `ON DELETE SET NULL`, so a reply whose parent
 * was deleted has a null parent while remaining a reply — under the old predicate
 * it would be published to the fediverse as a top-level Note, stripped of the
 * conversation it was written into. `is_reply` is the stored discriminator and
 * says what the post WAS WRITTEN AS, which is the question this predicate is
 * asking.
 */
function outboxScope(oxyUserId: string) {
  return and(
    eq(posts.oxyUserId, oxyUserId),
    eq(posts.visibility, 'public'),
    eq(posts.status, 'published'),
    eq(posts.isReply, false),
    // There is NO channel exclusion here, and adding one back would be wrong.
    // The outbox and the featured collection are AUTHOR surfaces, and a channel
    // is an Oxy account that AUTHORS its own posts — so this actor's outbox IS
    // the channel's own outbox when the actor is a channel, and a channel post
    // federates under the channel's identity like any other post. The
    // `channel_id is null` term that used to stand here existed only because a
    // channel post was authored by a PERSON and would otherwise have gone out
    // under the writer's actor.
    //
    // The scope stays shared across the three call sites so the count, the page
    // window and the featured collection cannot drift: a `totalItems` computed
    // under a different filter would promise items no page ever yields.
  );
}

/**
 * GET /ap/users/:username/outbox — User's public posts as OrderedCollection
 */
router.get('/users/:username/outbox', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);
  const page = req.query.page === 'true';

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code.
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = String(user._id || user.id);
    const [totals] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(outboxScope(userId));
    const totalPosts = totals?.count ?? 0;

    if (!page) {
      // Return collection summary
      res.set('Content-Type', AP_CONTENT_TYPE);
      return res.json({
        '@context': AP_CONTEXT,
        id: outboxUrl(username),
        type: 'OrderedCollection',
        totalItems: totalPosts,
        first: `${outboxUrl(username)}?page=true`,
      });
    }

    // Return paginated items. Keyset pagination by (createdAt, _id) — the same
    // ChronoCursor axis the native feeds use — so EVERY post is reachable by
    // walking `next`. Previously the page returned only the first 20 items with
    // no `next`, silently stranding every post beyond the first page from any AP
    // consumer that paginates (e.g. a 42-post outbox exposed only 20). Overfetch
    // one extra row to detect whether a further page exists without a second
    // count query.
    const PAGE_SIZE = 20;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    // The cursor DECODER and the query widened together. A cursor names an
    // arbitrary `posts.id` — an ObjectId hex before the cutover, a uuid v7 after
    // — so a decoder that still validated ObjectIds would discard every
    // post-cutover cursor and re-serve page one forever, while a widened decoder
    // feeding a Mongo `ObjectId` constructor would turn a clean 400 into a
    // CastError 500. `chronoCursorSql` is both halves at once.
    const keyset = await chronoCursorSql(cursor);
    const scope = outboxScope(userId);
    const overfetched = await findPostRecords(
      keyset ? and(scope, keyset) : scope,
      { orderBy: chronoOrderBy(), limit: PAGE_SIZE + 1 },
    );

    const hasNext = overfetched.length > PAGE_SIZE;
    const pagePosts = hasNext ? overfetched.slice(0, PAGE_SIZE) : overfetched;

    // Reuse the SINGLE Note builder that push delivery uses, so outbox backfill
    // (Mastodon ≥4.4 imports up to 20 items on discovery) carries the same
    // fidelity as pushed posts: canonical url, hashtag `tag`s, media `attachment`s,
    // AND resolved @mention anchors/tags (never a raw `[mention:<id>]` placeholder).
    // Mentions are batch-resolved for the whole page in two reads.
    const mentionContexts = await activityPubConnector.resolveMentionContextByPost(pagePosts);
    // Poll posts serialize as `Question`; batch-resolve their tallies for the whole
    // page in one Poll read (non-poll posts are absent → plain Note).
    const pollContexts = await activityPubConnector.resolvePollContextByPost(pagePosts);
    // Quote posts carry the quoted object's canonical AP id (FEP-044f quote fields
    // + FEP-e232 Link tag); batch-resolve the whole page's quote references, deduped
    // (non-quote posts are absent → plain Note).
    const quoteContexts = await activityPubConnector.resolveQuoteContextByPost(pagePosts);
    const items = pagePosts.map((post) =>
      activityPubConnector.buildCreateNoteActivity(
        post,
        username,
        undefined,
        mentionContexts.get(post.id),
        pollContexts.get(post.id),
        quoteContexts.get(post.id),
      ),
    );

    const pageId = cursor
      ? `${outboxUrl(username)}?page=true&cursor=${encodeURIComponent(cursor)}`
      : `${outboxUrl(username)}?page=true`;

    const pageResponse: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: pageId,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl(username),
      totalItems: totalPosts,
      orderedItems: items,
    };

    if (hasNext) {
      const lastPost = pagePosts[pagePosts.length - 1];
      const nextCursor = ChronoCursor.build(lastPost.id, lastPost.createdAt);
      pageResponse.next = `${outboxUrl(username)}?page=true&cursor=${encodeURIComponent(nextCursor)}`;
    }

    res.set('Content-Type', AP_CONTENT_TYPE);
    return res.json(pageResponse);
  } catch (err) {
    logger.error('Outbox endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /ap/users/:username/collections/featured — Featured collection (pinned posts)
 *
 * Mastodon does NOT backfill a freshly-discovered remote account's timeline from
 * the `outbox`; on profile view it fetches this `featured` collection (advertised
 * on the actor) and renders those PINNED posts. Without it a discovered Mention
 * profile shows avatar/banner/post-count but ZERO posts. This is the fix.
 *
 * Returns a NON-paginated `OrderedCollection` whose `orderedItems` are the user's
 * pinned posts as bare AP `Note` objects (NOT `Create` activities) — reusing the
 * SAME Note builder as the outbox/push/dereference paths (unwrapping the `Create`
 * envelope), so featured Notes carry identical fidelity. Ownership + visibility
 * exactly mirror the outbox filter (public + published + top-level, owned by the
 * named user), plus `metadata.isPinned`; newest-first. Same fediverse-sharing
 * consent gate + 404-when-off behavior as the sibling AP surfaces.
 */
router.get('/users/:username/collections/featured', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code.
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = String(user._id || user.id);

    // Only PUBLIC + PUBLISHED top-level pinned posts are exposed — identical
    // ownership/visibility filter to the outbox, narrowed to pinned. Mastodon
    // caps featured display at ~5, but we serve all pinned posts newest-first;
    // FEATURED_LIMIT is a defensive upper bound.
    const FEATURED_LIMIT = 20;
    const pinnedPosts = await findPostRecords(
      and(outboxScope(userId), eq(posts.metadataIsPinned, true)),
      { orderBy: [desc(posts.createdAt), desc(posts.id)], limit: FEATURED_LIMIT },
    );

    // Build via the shared Note path (batch-resolving @mentions for the whole
    // collection so no pinned Note leaks a `[mention:<id>]` placeholder), then
    // unwrap the Create envelope: a featured collection contains bare Note OBJECTS,
    // carrying no per-item `@context` (the collection's top-level `@context` covers
    // them).
    const mentionContexts = await activityPubConnector.resolveMentionContextByPost(pinnedPosts);
    const pollContexts = await activityPubConnector.resolvePollContextByPost(pinnedPosts);
    const quoteContexts = await activityPubConnector.resolveQuoteContextByPost(pinnedPosts);
    const items = pinnedPosts.map(
      (post) =>
        activityPubConnector.buildCreateNoteActivity(
          post,
          username,
          undefined,
          mentionContexts.get(post.id),
          pollContexts.get(post.id),
          quoteContexts.get(post.id),
        ).object as Record<string, unknown>,
    );

    res.set('Content-Type', AP_CONTENT_TYPE);
    res.set('Cache-Control', 'max-age=300');
    return res.json({
      '@context': AP_CONTEXT,
      id: featuredUrl(username),
      type: 'OrderedCollection',
      totalItems: items.length,
      orderedItems: items,
    });
  } catch (err) {
    logger.error('Featured collection endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /ap/users/:username/posts/:id — Dereference a single post as an AP Note.
 *
 * The Note id minted everywhere (push delivery, outbox, `buildCreateNoteActivity`)
 * is `https://<domain>/ap/users/<username>/posts/<postId>`, so this route MUST
 * serve that object for Mastodon's URL-search import of an old post to work — the
 * remote server fetches the Note id it discovered and expects the Note JSON back.
 *
 * Visibility gating: only PUBLIC + PUBLISHED posts owned by the named user are
 * dereferenceable; anything else 404s (never leak drafts/private/other-user
 * posts). Reuses the SAME Note-building path as the outbox (Task 2), unwrapping
 * the Create envelope to return the bare Note with its own `@context`.
 */
router.get('/users/:username/posts/:id', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);
  const postId = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);

  if (!wantsActivityPub(req)) {
    // A human/browser hit the Note URL — send them to the on-site post.
    return res.redirect(`https://${FEDERATION_DOMAIN}/@${username}/posts/${postId}`);
  }

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code. This route was not in the original
    // gate list but serves a user's content the same as the other AP
    // surfaces, so it gets the same treatment.
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = String(user._id || user.id);

    // No id-shape guard: `posts.id` is `text`, so an arbitrary path segment is a
    // parameter that matches no row rather than a cast that throws — the 404 the
    // ObjectId check used to produce, without rejecting every post created since
    // the cutover. A REPLY is dereferenceable here (unlike in the outbox): the
    // remote server asked for this exact Note by id, and the reply carries its own
    // `inReplyTo` below.
    const post = await loadPostRecord(postId);
    if (
      !post
      || post.oxyUserId !== userId
      || post.visibility !== 'public'
      || post.status !== 'published'
    ) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // When the dereferenced post is a REPLY, carry `inReplyTo` + the parent-author
    // `Mention` so a remote server that pulls this Note by URL threads it. Resolved
    // here (the builder stays pure); fail-soft — a non-reply or unresolvable parent
    // yields null, so the Note is served without `inReplyTo` rather than erroring.
    const replyContext = await activityPubConnector.resolveReplyContext(post);

    // Resolve the post's @mentions so a pulled Note carries mention anchors + tags
    // (never a raw `[mention:<id>]` placeholder). Fail-soft — null when it mentions
    // nobody; the linkifier still strips any stray placeholder from the body.
    const mentionContext = await activityPubConnector.resolveMentionContext(post);

    // A poll post is dereferenced as a `Question` (options + current tallies);
    // null for a non-poll post, which serves a plain Note.
    const pollContext = await activityPubConnector.resolvePollContext(post);

    // A quote post carries the quoted object's canonical AP id (FEP-044f quote
    // fields + FEP-e232 Link tag); null for a non-quote post or an unresolvable
    // quoted post, which serves the Note without quote fields.
    const quoteContext = await activityPubConnector.resolveQuoteContext(post);

    // Build via the shared Note path, then unwrap the Create envelope: a
    // dereferenced Note/Question is the `object`, carrying its own top-level
    // `@context`.
    const activity = activityPubConnector.buildCreateNoteActivity(
      post,
      username,
      replyContext ?? undefined,
      mentionContext ?? undefined,
      pollContext ?? undefined,
      quoteContext ?? undefined,
    );
    const note = activity.object as Record<string, unknown>;

    res.set('Content-Type', AP_CONTENT_TYPE);
    res.set('Cache-Control', 'max-age=300');
    return res.json({ '@context': AP_CONTEXT, ...note });
  } catch (err) {
    logger.error('Post dereference endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
