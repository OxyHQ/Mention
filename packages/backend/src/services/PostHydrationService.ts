/**
 * The one authority for post DTOs. This file is the orchestration only: it walks
 * the request through `postHydration/` in order (reference graph, viewer context,
 * batched maps, access decisions, DTO assembly). Controllers never hand-build a
 * post; they call `hydratePosts` or `hydrateSlices`.
 *
 * Module map, `services/postHydration/`:
 * - `types.ts`: the hydration input and context shapes.
 * - `graph.ts`: walking boosts, quotes and reply parents, and deciding what the viewer may read in that graph.
 * - `viewerContext.ts`: who is asking: blocks, follows, privacy, languages, operated accounts.
 * - `readability.ts`: the access predicates for one post.
 * - `authorMaps.ts`, `contentMaps.ts`, `threadMaps.ts`: the batched lookups, one query per kind per request.
 * - `userSummaries.ts`: resolving authors through Oxy, with its cache and failure budget.
 * - `dto.ts`, `mentions.ts`: turning a raw post and those maps into the served DTO.
 */
import { hydratePostMedia, prefetchPostMediaAccess } from './hydratePostMedia';
import type { SafetyDecision } from '@oxy.so/contracts';
import { loadPostSafetyDecisions } from './postSafetyAccess';
import { UNRATED_MATERIAL_ITEM } from './contentAccessBatcher';
import { recordHydrationRevisions } from './hydrationRevisions';
import { loadPostSafetyAssessments } from '../db/posts/postSafetyRepository';
import type {
  FeedPostSlice,
  FeedSliceItem,
  HydratedPost,
  HydratedPostSummary,
  PostUser,
} from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../db/postgres';
import { completeShellRecords, loadPostRecords } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { loadShownNotes } from './communityNotes/CommunityNotesService';
import { assignThreadState } from './ThreadSlicingService';
import { normalizeAuthorship } from '../utils/postAuthorship';
import type { HydrationOptions, RawPost } from './postHydration/types';
import {
  collectPostsWithDepth,
  decideGraphAccess,
  externalParentIds,
  extractReferenceIds,
  loadReplyParents,
  MAX_REQUIRED_REFERENCE_DEPTH,
  resolveId,
  storedMediaIds,
} from './postHydration/graph';
import { buildViewerContext, populateViewerInteractions } from './postHydration/viewerContext';
import {
  buildClarityDocumentMap,
  buildCrosspostMap,
  buildImportMap,
  buildLaneMap,
  buildPollMap,
  buildQuoteCountMap,
  buildResolvedVariantMap,
  type ClarityDocumentMap,
} from './postHydration/contentMaps';
import {
  buildReplierAvatarsFromUserMap,
  buildReplyParentAuthorMap,
  loadRecentReplierProjection,
} from './postHydration/threadMaps';
import {
  buildAuthorPrivacyMap,
  buildOrphanFederatedAuthorMap,
  buildSigningChannelIds,
  buildUserMap,
  collectDisclosedWriterIds,
} from './postHydration/authorMaps';
import { attachNestedContext, buildPostSummary } from './postHydration/dto';
import { canViewerReadPost, viewerIsRecipient, viewerOwnsPost } from './postHydration/readability';
import { resolveMentionText } from './postHydration/mentions';

// The public import path keeps working: these used to be declared in this file.
export type { HydrationOptions } from './postHydration/types';
export {
  degradedActorSummary,
  isFallbackUserSummary,
  OXY_USER_ABSENT_TTL_MS,
  OXY_USER_FAILURE_TTL_MS,
  OXY_USER_FALLBACK_CONCURRENCY,
  OXY_USER_RESOLUTION_DEADLINE_MS,
  resetOxyUserFailureMemory,
  resolveOrphanFederatedAuthors,
  resolveUserSummaries,
} from './postHydration/userSummaries';

export class PostHydrationService {
  async hydratePosts(rawPosts: object[], options: HydrationOptions = {}): Promise<HydratedPost[]> {
    if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
      return [];
    }

    const maxDepth = Math.max(0, options.maxDepth ?? 1);
    const normalizedPosts = rawPosts.map(
      (p): RawPost =>
        typeof (p as { toObject?: () => RawPost }).toObject === 'function'
          ? (p as { toObject: () => RawPost }).toObject()
          : (p as RawPost),
    );
    // The page's own reply parents are known from the rows in hand, so their
    // read starts NOW, beside the viewer context and the reference walk, instead
    // of after both. It is a read, never a disclosure: what a parent may reveal
    // is decided below, under the same ACL as every other post in the graph.
    const pageIds = new Set(normalizedPosts.filter(Boolean).map((post) => resolveId(post)));
    const earlyParentIds = externalParentIds(normalizedPosts.filter(Boolean), pageIds);
    const earlyParents = earlyParentIds.length
      ? loadReplyParents(earlyParentIds)
      : Promise.resolve<RawPost[]>([]);
    // Awaited below; until then a rejection must not surface as unhandled.
    earlyParents.catch(() => undefined);
    const viewerContext = await buildViewerContext(rawPosts, options.viewerId, options);

    const initialPosts = normalizedPosts.filter((post) => {
      if (!post) return false;
      const authorId = post.oxyUserId ? String(post.oxyUserId) : undefined;
      if (authorId) return !viewerContext.blockedIds.has(authorId);
      // A FEDERATED post whose Oxy author link is missing (a legacy "orphan",
      // ingested before the federated-actor → Oxy-user link was enforced) is
      // NOT a data error — it still renders in a degraded form (see
      // buildPostSummary) so the post itself, and any boost/quote referencing
      // it, is not blank. A native post with no author IS a data error → drop.
      return Boolean(post.federation?.activityId);
    });

    if (initialPosts.length === 0) {
      return [];
    }

    const graph = await collectPostsWithDepth(
      initialPosts,
      maxDepth,
      viewerContext.blockedIds,
      options.publicReferencesOnly === true,
    );

    const postIds = Array.from(graph.keys());
    // Every post row actually fetched into the graph (initial posts + collected
    // references). Used by `attachNestedContext` to tell a GENUINELY-MISSING boost
    // original (never fetched → not here) from one dropped by an ACL check.
    const collectedPostIds = new Set(postIds);
    const collectedPosts = Array.from(graph.values());
    if (options.viewerId && !options.safetyRequester)
      throw new Error('Authenticated hydration requires an explicit safety requester');
    const parentIds = externalParentIds(
      collectedPosts.map(({ post }) => post),
      graph,
    );
    // Only the parents of posts the reference walk added are still unread; the
    // page's own were started above. Those and the safety evidence for the whole
    // graph (parents included) are independent reads, so neither waits for the
    // other.
    const earlyParentIdSet = new Set(earlyParentIds);
    const lateParentIds = parentIds.filter((id) => !earlyParentIdSet.has(id));
    const wantedParentIds = new Set(parentIds);
    const [earlyParentRows, lateParentRows, assessments] = await Promise.all([
      earlyParents,
      lateParentIds.length ? loadReplyParents(lateParentIds) : Promise.resolve<RawPost[]>([]),
      loadPostSafetyAssessments([...graph.keys(), ...parentIds]),
    ]);
    // A parent the walk pulled into the graph itself is a graph node, not a
    // parent to preload — exactly the set `parentIds` excludes.
    const preloadedReplyParents = [...earlyParentRows, ...lateParentRows].filter((post) =>
      wantedParentIds.has(resolveId(post)),
    );
    const policyPosts = [
      ...Array.from(graph, ([id, { post }]) => ({ ...post, id })),
      ...preloadedReplyParents.map((post) => ({ ...post, id: resolveId(post) })),
    ];
    const managementIds = new Set(options.manageOwnPostIds ?? []);
    const safetyRequester = options.safetyRequester ?? { accessToken: null };
    const safetyDecisions = await decideGraphAccess(policyPosts, viewerContext, options, {
      assessments,
      operationFor: (id) =>
        managementIds.has(id) && graph.get(id)?.depth === 0 ? 'manage_own' : 'read',
    });
    // Nothing eligible means nothing is shown; there was no question to ask.
    if (!safetyDecisions) return [];
    const postsForHydration = collectedPosts.filter(
      ({ post }) => safetyDecisions.get(resolveId(post) ?? '')?.allowed === true,
    );

    if (!postsForHydration.length) return [];
    const allowUnratedAttachments =
      safetyDecisions.get(UNRATED_MATERIAL_ITEM.resourceId)?.allowed === true;
    // What this hydration rendered from, for a caller caching the result (see
    // `hydrationRevisions`). The parents are included: whom a reply answers is
    // read from them.
    recordHydrationRevisions(
      [...collectedPosts.map(({ post }) => post), ...preloadedReplyParents].map((post) => ({
        id: resolveId(post),
        record: post,
      })),
      allowUnratedAttachments,
    );

    // Resolve each post's localized rendition for THIS viewer, once. Everything
    // downstream — the body, the media (with its localized alt), the article, and
    // the link previews extracted from the text — reads the resolved rendition, so
    // a reader never sees one language's text beside another language's images.
    const resolvedMap = buildResolvedVariantMap(postsForHydration, viewerContext);
    // The viewer's file ACL depends only on which files these (already admitted)
    // posts can render, so Oxy is asked now, beside the hydration reads below,
    // rather than after every summary has been built.
    const mediaAccess = prefetchPostMediaAccess(
      postsForHydration.flatMap(({ post }) => storedMediaIds(post)),
      safetyRequester,
    );

    // Run independent hydration steps in parallel to minimize waterfall latency.
    // Dependency chain: loadRecentReplierProjection → buildUserMap → buildReplierAvatarsFromUserMap
    // Everything else is independent and can run concurrently.
    const [
      ,
      {
        userMap,
        recentReplierMap,
        replyParentAuthorIdByPostId,
        selfContinuationPostIds,
        signingChannelIds,
      },
      pollMap,
      authorPrivacyMap,
      linkPreviewMap,
      orphanAuthorMap,
      quoteCountMap,
      laneMap,
      crosspostMap,
      importMap,
    ] = await Promise.all([
      populateViewerInteractions(postIds, viewerContext),
      (async () => {
        // The reply-parent lookup runs BESIDE the replier projection, not after
        // it: both only need the collected graph, and both feed the SAME user
        // batch below. So resolving "whom does each reply answer" adds no Oxy
        // round trip and no latency of its own — the parent authors are merged
        // into the one `buildUserMap` call the rest of hydration already makes.
        // The channel-disclosure lookup joins them for the same reason: it is
        // one indexed settings query over the graph, it feeds the SAME user
        // batch, and its answer is what decides whether a channel's WRITER is
        // resolved at all. An undisclosed writer is never even looked up.
        const [replierAggResult, replyParents, signingIds] = await Promise.all([
          loadRecentReplierProjection(postIds),
          buildReplyParentAuthorMap(postsForHydration, preloadedReplyParents, safetyDecisions),
          buildSigningChannelIds(postsForHydration),
        ]);
        const extraUserIds = new Set(replierAggResult.allReplierIds);
        for (const parentAuthorId of replyParents.parentAuthorIds) {
          extraUserIds.add(parentAuthorId);
        }
        for (const writerId of collectDisclosedWriterIds(postsForHydration, signingIds)) {
          extraUserIds.add(writerId);
        }
        // The community a post was written in is an account like its author, so
        // it rides the same batch rather than a lookup of its own.
        for (const { post } of postsForHydration) {
          if (post.communityOxyUserId) extraUserIds.add(post.communityOxyUserId);
        }
        const uMap = await buildUserMap(postsForHydration, extraUserIds);
        const rMap = buildReplierAvatarsFromUserMap(replierAggResult.perPostRepliers, uMap);
        return {
          userMap: uMap,
          recentReplierMap: rMap,
          replyParentAuthorIdByPostId: replyParents.parentAuthorIdByPostId,
          selfContinuationPostIds: replyParents.selfContinuationPostIds,
          signingChannelIds: signingIds,
        };
      })(),
      buildPollMap(postsForHydration, viewerContext.viewerId),
      buildAuthorPrivacyMap(postsForHydration, viewerContext),
      options.includeLinkMetadata !== false
        ? buildClarityDocumentMap(postsForHydration, resolvedMap)
        : Promise.resolve<ClarityDocumentMap>({ documents: new Map(), pending: new Set() }),
      buildOrphanFederatedAuthorMap(postsForHydration),
      // `undefined` (not an empty Map) when the caller did not ask, so a post
      // with zero quotes is still reported as 0 rather than as "not counted".
      options.includeQuoteCounts === true
        ? buildQuoteCountMap(postIds)
        : Promise.resolve(undefined),
      buildLaneMap(postsForHydration),
      // Cross-post provenance for the whole page in ONE query — an `in (...)`
      // over the batch, so twenty posts cost what one does.
      //
      // Skipped entirely when the batch holds no federated post. A cross-post
      // cluster needs two federated variants on a reviewed pair of networks, so
      // a page of native posts cannot contain one, and an all-native feed — the
      // overwhelmingly common case — pays nothing at all rather than one
      // statement for a field it can never have. The test is over rows already
      // in memory, so the saving is free.
      buildCrosspostMap(postsForHydration, postIds),
      // Import provenance ("Originally posted on Mastodon") for the whole page in
      // ONE primary-key `in (...)` — see `buildImportMap`.
      buildImportMap(postsForHydration),
    ]);
    const mentionCache: Map<string, PostUser> = new Map(userMap);

    const summaryMap = new Map<string, HydratedPostSummary>();

    const summaries = await Promise.all(
      postsForHydration.map(({ post }) =>
        buildPostSummary({
          post,
          viewerContext,
          pollMap,
          userMap,
          mentionCache,
          linkPreviewMap,
          authorPrivacyMap,
          recentReplierMap,
          orphanAuthorMap,
          resolvedMap,
          quoteCountMap,
          replyParentAuthorIdByPostId,
          selfContinuationPostIds,
          laneMap,
          crosspostMap,
          importMap,
          signingChannelIds,
        }),
      ),
    );
    await hydratePostMedia(
      summaries.filter((summary): summary is HydratedPostSummary => summary !== null),
      safetyRequester,
      mediaAccess,
    );
    for (const summary of summaries) {
      if (summary) {
        if (!allowUnratedAttachments) {
          // A reviewed post does not review its mutable byline images, lane
          // title, fetched cards, or other independently authored attachments.
          summary.user = { ...summary.user, avatar: undefined };
          summary.authors = summary.authors.map((author) => ({ ...author, avatar: undefined }));
          summary.engagement.recentReplierAvatars = [];
          if (summary.replyContext?.parentAuthor)
            summary.replyContext = {
              ...summary.replyContext,
              parentAuthor: { ...summary.replyContext.parentAuthor, avatar: undefined },
            };
          if (summary.community) summary.community = { ...summary.community, avatar: undefined };
          delete summary.lane;
          delete summary.documents;
          delete summary.documentsPending;
        }
        summaryMap.set(summary.id, summary);
      }
    }

    const hydratedResults: HydratedPost[] = [];
    const recordsById = new Map(postsForHydration.map(({ post }) => [resolveId(post), post]));
    // Build a bounded tree from the already-authorized graph. Nested quotes
    // must retain their context when the selected post is a boost of a quote.
    // Never mutate shared summaries: two selected roots can reference each other.
    const withContext = (
      id: string,
      remaining: number,
      ancestors: Set<string>,
    ): HydratedPost | null => {
      const summary = summaryMap.get(id);
      const post = recordsById.get(id);
      if (!summary || !post) return null;
      if (remaining <= 0 || ancestors.has(id)) return summary;
      const path = new Set([...ancestors, id]);
      const nested = new Map<string, HydratedPostSummary>();
      for (const reference of extractReferenceIds(post)) {
        if (path.has(reference)) continue;
        const child = withContext(reference, remaining - 1, path);
        if (child) nested.set(reference, child);
      }
      return attachNestedContext(
        post,
        summary,
        nested,
        collectedPostIds,
        options.publicReferencesOnly === true,
        recordsById,
      );
    };

    for (const { post, depth } of postsForHydration) {
      if (depth !== 0) continue;
      const postId = resolveId(post);
      const summary = summaryMap.get(postId);
      if (!summary) continue;

      const hydrated = withContext(
        postId,
        Math.max(maxDepth, MAX_REQUIRED_REFERENCE_DEPTH),
        new Set(),
      );
      if (hydrated) {
        hydratedResults.push(hydrated);
      }
    }

    // After the ACL, not before: a note is attached to the posts this viewer
    // actually receives, so a post dropped by `attachNestedContext` never costs
    // a lookup and a note never travels attached to a post that did not survive.
    if (allowUnratedAttachments) await this.attachCommunityNotes(hydratedResults, options);

    return hydratedResults;
  }

  /**
   * Current content decisions for a graph of post records, exactly as
   * {@link hydratePosts} makes them for an ANONYMOUS reader, plus the generic
   * unrated-material decision under {@link UNRATED_MATERIAL_ITEM}'s id — without
   * hydrating anything.
   *
   * For a caller that already holds a hydrated rendering of these records (the
   * anonymous feed cache) and must re-authorize it on every read. Fails closed:
   * a failed privacy read or Oxy call rejects. Returns an empty map when no
   * record is eligible, in which case nothing may be shown.
   */
  async authorizeAnonymousRecords(
    records: readonly object[],
  ): Promise<Map<string, SafetyDecision>> {
    const posts = records as RawPost[];
    if (posts.length === 0) return new Map();
    const ids = posts.map((post) => resolveId(post));
    // Anonymous only: a signed-in viewer's decisions also depend on blocks,
    // follows and operated accounts, which this does not load.
    const options: HydrationOptions = { safetyRequester: { accessToken: null } };
    const [viewerContext, assessments] = await Promise.all([
      // The access-check form: no language work, and a privacy read failure
      // rejects instead of degrading.
      buildViewerContext(posts, undefined, options, getDb()),
      loadPostSafetyAssessments(ids),
    ]);
    return (
      (await decideGraphAccess(
        posts.map((post, index) => ({ ...post, id: ids[index] })),
        viewerContext,
        options,
        { assessments, operationFor: () => 'read' },
      )) ?? new Map()
    );
  }

  /**
   * Attach each post's shown community note, when CrowdSource has one.
   *
   * Fail-open by construction: {@link loadShownNotes} answers with whatever it
   * could resolve and never rejects, so a CrowdSource outage renders the page
   * exactly as it rendered before notes existed. The note is set on the hydrated
   * post rather than on the shared summary, because one summary can also be the
   * quoted or boosted original inside another post in the same batch, and a note
   * belongs under the post being READ.
   */
  private async attachCommunityNotes(
    posts: HydratedPost[],
    options: HydrationOptions,
  ): Promise<void> {
    if (options.includeCommunityNotes === false || posts.length === 0) return;
    const notes = await loadShownNotes(posts.map((post) => post.id));
    if (notes.size === 0) return;
    for (const post of posts) {
      const note = notes.get(post.id);
      if (note) post.communityNote = note;
    }
  }

  /**
   * Hydrate all posts across multiple slices in a single batch,
   * then reconstruct slices with hydrated data.
   * This prevents per-slice hydration overhead (N+1 at the slice level).
   */
  async hydrateSlices(
    slices: FeedPostSlice[],
    options: HydrationOptions = {},
  ): Promise<FeedPostSlice[]> {
    if (slices.length === 0) return [];

    // Collect ALL posts from ALL slices into a flat array for batch hydration
    const allRawPosts: object[] = [];
    const postIdToSlicePositions = new Map<string, Array<{ sliceIdx: number; itemIdx: number }>>();

    for (let si = 0; si < slices.length; si++) {
      for (let ii = 0; ii < slices[si].items.length; ii++) {
        const rawPost = slices[si].items[ii].post as unknown as RawPost;
        const postId =
          (rawPost?.id as string | undefined) || (rawPost?._id ? String(rawPost._id) : '') || '';
        if (!postId) continue;

        allRawPosts.push(rawPost);
        if (!postIdToSlicePositions.has(postId)) {
          postIdToSlicePositions.set(postId, []);
        }
        postIdToSlicePositions.get(postId)!.push({ sliceIdx: si, itemIdx: ii });
      }
    }

    // For You's candidate sources may hand back UNASSEMBLED shells — flat
    // columns only, `authorship`/`mentions`/`content` media/variants left at
    // their empty default (see `assembleShellRecords` in `postRepository.ts`)
    // — to avoid paying for a 9-table join on every candidate ranking then
    // discards. This is the one choke point every ranked/sliced feed's posts
    // pass through before hydration, so it is where the DEFERRED join finally
    // happens, for exactly the page that survived to here — from the `posts`
    // rows the shells already carry, so only the child tables are read. Any
    // other feed type, which never produces a shell, pays nothing extra: the
    // scan below finds nothing and `unassembled` stays empty.
    const unassembled = allRawPosts.filter(
      (post) => (post as { _unassembled?: boolean })._unassembled === true,
    ) as PostRecord[];
    if (unassembled.length > 0) {
      const assembledById = await completeShellRecords(unassembled);
      for (let i = 0; i < allRawPosts.length; i++) {
        const shell = allRawPosts[i] as { id?: string; _unassembled?: boolean };
        if (shell._unassembled !== true) continue;
        const full = assembledById.get(shell.id ?? '');
        if (full) allRawPosts[i] = full;
      }
    }

    // Hydrate all posts in one batch
    const hydratedPosts = await this.hydratePosts(allRawPosts, options);

    // Build lookup: postId → HydratedPost
    const hydratedMap = new Map<string, HydratedPost>();
    for (const hp of hydratedPosts) {
      hydratedMap.set(hp.id, hp);
    }

    // Reconstruct slices with hydrated data
    const result: FeedPostSlice[] = [];
    for (const slice of slices) {
      const hydratedItems: FeedSliceItem[] = [];
      for (const item of slice.items) {
        const itemPost = item.post as unknown as RawPost;
        const postId =
          (itemPost?.id as string | undefined) || (itemPost?._id ? String(itemPost._id) : '') || '';
        const hydrated = hydratedMap.get(postId);
        if (hydrated) {
          hydratedItems.push({
            ...item,
            post: hydrated,
          });
        }
      }

      // Only include slices that have at least one hydrated item
      if (hydratedItems.length > 0) {
        // Recalculate thread state after filtering (items may have been dropped)
        const recalculated = assignThreadState(hydratedItems);

        // Recompute slice key only if items were dropped during hydration
        const sliceKey =
          hydratedItems.length === slice.items.length
            ? slice._sliceKey
            : recalculated.map((i) => i.post.id).join('+');

        // The reason SURVIVES an ACL-dropped parent. It used to be stripped,
        // because it carried `parentAuthor` and would then have named the author
        // of a post this viewer was just denied — but the author now lives on the
        // reply's own `replyContext`, gated by the same ACL, so there is nothing
        // left here to leak. Stripping it was also losing the only thing the
        // reason still asserts: that this item is a reply, which the `hideReplies`
        // tuner filters on. A viewer hiding replies would have been served the
        // ones whose parent they could not read.
        result.push({
          ...slice,
          _sliceKey: sliceKey,
          items: recalculated,
        });
      }
    }

    return result;
  }

  /**
   * May this viewer read the post with this id?
   *
   * The same question {@link canViewerReadPost} answers, asked by a caller that
   * holds an id rather than a hydrated graph — today the `joinPost` socket
   * handler, deciding whether a client may subscribe to a post's live counters.
   *
   * It is a real read of the real gate, not a cheaper approximation: the post is
   * loaded whole, the viewer context is built by the same builder hydration
   * uses, and the verdict comes from the same predicate. A "is it public?"
   * shortcut written at the call site would be a second visibility rule, and the
   * two would drift the first time either moved.
   *
   * A blocked author fails here too, matching hydration — which drops a blocked
   * author's post while COLLECTING it, before the gate below ever sees it, so
   * asking the gate alone would let through the one case hydration never serves.
   *
   * Costs one indexed primary-key lookup plus the viewer context (the viewer's
   * blocks/restrictions/graph) — the same work one post-detail request already
   * does. Callers must therefore bound how often they can ask.
   *
   * There is NO id-shape guard. The id reaches this seam straight from a client,
   * but `posts.id` is `text`, so a string that could never name a post is a bound
   * parameter that matches no row — which is already the `false` a guard would
   * have produced. An `isValidObjectId` test here would instead answer `false`
   * for every post created since the cutover, silently refusing every live
   * subscription.
   */
  async canViewerReadPostId(
    postId: string,
    viewerId: string,
    options?: Pick<HydrationOptions, 'oxyClient' | 'operatedAccountReader' | 'safetyRequester'>,
    db: DatabaseOrTransaction = getDb(),
  ): Promise<boolean> {
    // Read fresh, through the caller's handle: this answer may authorize a write
    // inside that caller's transaction, so it never comes from a cache.
    const [post] = (await loadPostRecords([postId], db)) as unknown as RawPost[];
    if (!post) return false;

    if (viewerId && !options?.safetyRequester)
      throw new Error('Authenticated post access requires an explicit safety requester');
    const authorId = post.oxyUserId ?? '';
    if (!authorId && !post.federation) return false;
    const viewerContext = await buildViewerContext([post], viewerId, options, db);
    const authorship = normalizeAuthorship(post.authorship);
    const resourceGrant =
      viewerOwnsPost(authorId, authorship, viewerContext) || viewerIsRecipient(post, viewerContext);
    if (
      viewerContext.blockedIds.has(authorId) ||
      (((post.status ?? 'published') !== 'published' ||
        viewerContext.restrictedIds.has(authorId)) &&
        !resourceGrant)
    )
      return false;
    const decisions = await loadPostSafetyDecisions(
      [{ ...post, id: postId }],
      options?.safetyRequester ?? { accessToken: null },
      new Map([
        [
          postId,
          {
            applicationAudienceAllowed: canViewerReadPost(
              post,
              authorId,
              authorship,
              viewerContext,
            ),
            applicationResourceGrant: resourceGrant,
          },
        ],
      ]),
    );
    return decisions.get(postId)?.allowed === true;
  }

  /**
   * Render a body outside hydration (a translate response) exactly as
   * hydration renders it: `[mention:<id>]` placeholders for the post's own
   * declared mentions become `[@Label](handle)`.
   */
  async renderMentionPlaceholders(text: string, mentions: readonly string[]): Promise<string> {
    return resolveMentionText(text, mentions, new Map());
  }
}

export const postHydrationService = new PostHydrationService();
