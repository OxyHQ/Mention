// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Walking a batch's reference graph (boosts, quotes, reply parents) and deciding what the viewer may read in it. */
import type { SafetyDecision } from '@oxy.so/contracts';
import { postSafetyItems, type PostSafetyApplicationAccess } from '../access/postSafetyAccess';
import { decideContentAccess, UNRATED_MATERIAL_ITEM } from '../../moderation/contentAccessBatcher';
import type { PostSafetyAssessments } from '../../../db/posts/postSafetyRepository';
import { PostVisibility } from '@mention/shared-types';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { posts } from '../../../db/schema/posts';
import { CHRONO_DESC, findPostRecords, loadPostRecords } from '../../../db/posts/postRepository';
import { getOrLoadPostRecords } from '../postDetailCache';
import { logger } from '../../../utils/logger';
import { normalizeAuthorship } from '../../../utils/postAuthorship';
import type { ExtendedViewerContext, HydratedGraphNode, HydrationOptions, RawPost } from './types';
import { resolveCurrentChannelAuthority } from './viewerContext';
import { canViewerReadPost, viewerIsRecipient, viewerOwnsPost } from './readability';

/**
 * Loading a reply's PARENT, only to answer "whom does this reply answer" (see
 * `buildReplyParentAuthorMap`).
 *
 * A WHOLE record rather than a projection, deliberately. Two of the four fields
 * the ACL reads are not columns of `posts`: `authorship` is `post_authorships`,
 * and `federation` is assembled from a family of `federation_*` columns. A
 * hand-narrowed select would have to reproduce both assemblies, and the failure
 * mode of getting one wrong is silent — `canViewerReadPost` reads a missing
 * `status` as published and a missing `authorship` as "no collaborators", so the
 * gate stops gating rather than erroring. The parent's body is never rendered
 * from here; it is thrown away the moment its author id is taken.
 */
export async function loadReplyParents(postIds: readonly string[]): Promise<RawPost[]> {
  // Through the viewer-agnostic record cache: a thread's parent is the same row
  // for every reply under it and every reader of them, and it is the cache that
  // edits, visibility, authorship and deletes already invalidate.
  const records = await getOrLoadPostRecords(postIds, (ids) => loadPostRecords(ids));
  return records as unknown as RawPost[];
}

/**
 * The parents a set of posts replies to that are not among those posts.
 * Deduplicated, in first-seen order.
 */
export function externalParentIds(posts: Iterable<RawPost>, present: { has(id: string): boolean }) {
  const ids = new Set<string>();
  for (const post of posts) {
    const parentId = post.parentPostId ? String(post.parentPostId) : '';
    if (parentId && !present.has(parentId)) ids.add(parentId);
  }
  return [...ids];
}

/** Every Oxy file a stored post can render: its media and each rendition's own. */
export function storedMediaIds(post: RawPost): string[] {
  const content = post.content;
  if (!content) return [];
  const ids: string[] = [];
  const collect = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const id = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id;
      if (id) ids.push(String(id));
    }
  };
  collect(content.media);
  for (const variant of content.variants ?? []) collect(variant.media);
  return ids;
}

/**
 * The eligibility filter and ONE Oxy content-access batch for a post graph,
 * shared by {@link hydratePosts} and {@link authorizeAnonymousRecords} so the two can
 * never disagree. `null` when no post is eligible (no question was asked).
 */
export async function decideGraphAccess(
  policyPosts: Array<RawPost & { id: string }>,
  viewerContext: ExtendedViewerContext,
  options: HydrationOptions,
  input: {
    assessments: Promise<PostSafetyAssessments> | PostSafetyAssessments;
    operationFor: (postId: string) => PostSafetyApplicationAccess['operation'];
  },
): Promise<Map<string, SafetyDecision> | null> {
  await resolveCurrentChannelAuthority(policyPosts, viewerContext, options);
  const applicationAccess = new Map<string, PostSafetyApplicationAccess>();
  const eligiblePosts = policyPosts.filter((post) => {
    const authorId = post.oxyUserId ?? '';
    const authorship = normalizeAuthorship(post.authorship);
    const resourceGrant =
      viewerOwnsPost(authorId, authorship, viewerContext) || viewerIsRecipient(post, viewerContext);
    // Contact approval only decides a published post's audience. It cannot
    // disclose an unpublished draft or override an application restriction.
    if (
      viewerContext.blockedIds.has(authorId) ||
      (((post.status ?? 'published') !== 'published' ||
        viewerContext.restrictedIds.has(authorId)) &&
        !resourceGrant)
    )
      return false;
    applicationAccess.set(post.id, {
      applicationAudienceAllowed: canViewerReadPost(post, authorId, authorship, viewerContext),
      applicationResourceGrant: resourceGrant,
      operation: input.operationFor(post.id),
    });
    return true;
  });
  const safetyItems = await postSafetyItems(
    eligiblePosts,
    applicationAccess,
    Promise.resolve(input.assessments),
  );
  if (!safetyItems.length) return null;
  // The graph's posts and the generic unrated-material question go to Oxy as
  // ONE batch; a decision this request already has costs no call at all.
  return decideContentAccess(
    [...safetyItems, UNRATED_MATERIAL_ITEM],
    options.safetyRequester ?? { accessToken: null },
  );
}

// Quotes and boosts need their referenced content even in shallow feeds.
// Two mandatory hops cover a boosted quote or a quote of a quote; deeper
// chains remain bounded rather than traversing arbitrary reference graphs.
export const MAX_REQUIRED_REFERENCE_DEPTH = 2;

export async function collectPostsWithDepth(
  initialPosts: RawPost[],
  maxDepth: number,
  blockedIds: Set<string>,
  publicReferencesOnly: boolean,
): Promise<Map<string, HydratedGraphNode>> {
  const result = new Map<string, HydratedGraphNode>();
  const visited = new Set<string>();

  let currentLevel = initialPosts.map((post): HydratedGraphNode => ({ post, depth: 0 }));

  // The collection runs at least one level beyond `maxDepth` so a boost's
  // mandatory original (forced below, regardless of `maxDepth`) is always
  // fetched. The per-entry guards still respect `maxDepth` for OPTIONAL
  // references, so this added iteration only ever fetches forced boost
  // originals — never expands the normal depth budget.
  const collectionDepthCap = Math.max(maxDepth, MAX_REQUIRED_REFERENCE_DEPTH);

  for (let depth = 0; depth <= collectionDepthCap && currentLevel.length > 0; depth++) {
    const nextIdMap = new Map<string, number>();

    for (const entry of currentLevel) {
      const id = resolveId(entry.post);
      if (!id || visited.has(id)) continue;
      visited.add(id);

      const authorId = entry.post?.oxyUserId ? String(entry.post.oxyUserId) : undefined;
      if (authorId && blockedIds.has(authorId)) {
        continue;
      }

      result.set(id, { post: entry.post, depth: entry.depth });

      const enqueueRef = (refId: string) => {
        if (!refId || visited.has(refId)) return;
        const nextDepth = entry.depth + 1;
        const existing = nextIdMap.get(refId);
        nextIdMap.set(refId, existing === undefined ? nextDepth : Math.min(existing, nextDepth));
      };

      // A `type:'boost'` post has an intentionally EMPTY content body and is
      // NOT renderable without its boosted original — the original is part of
      // the boost's own content, not optional nested context. So ALWAYS
      // collect a boost's direct `boostOf` original one hop deep, independent
      // of the caller's `maxDepth`. Without this, any endpoint that hydrates
      // boosts at `maxDepth: 0` (most feed paths) silently returns a blank
      // boost. Bounded by `collectionDepthCap` so a boost-of-boost chain
      // cannot fan out indefinitely.
      if (entry.depth < collectionDepthCap) {
        const forcedOriginalId = extractRepostOriginalId(entry.post);
        if (forcedOriginalId) {
          enqueueRef(forcedOriginalId);
        }
      }

      // A quote's subject is part of its content too. Feed callers use depth
      // zero; that must not silently remove the quoted card. Two forced hops
      // also preserve a boost of a quote without traversing arbitrary chains.
      if (entry.depth < MAX_REQUIRED_REFERENCE_DEPTH && entry.post.quoteOf) {
        for (const quoteId of extractReferenceIds({ quoteOf: entry.post.quoteOf }))
          enqueueRef(quoteId);
      }

      // Other references still respect the caller's optional context budget.
      if (entry.depth < maxDepth) {
        for (const refId of extractReferenceIds(entry.post)) {
          enqueueRef(refId);
        }
      }
    }

    if (nextIdMap.size === 0) {
      break;
    }

    const nextIds = Array.from(nextIdMap.keys());
    const referenceScope: SQL[] = [inArray(posts.id, nextIds)];
    if (publicReferencesOnly) {
      referenceScope.push(eq(posts.status, 'published'));
      referenceScope.push(eq(posts.visibility, PostVisibility.PUBLIC));
    }

    try {
      // Ordered because `findPostRecords` requires it, not because the caller
      // cares: the results are re-keyed by id into `nextIdMap` immediately
      // below, so the query's own order never reaches a reader.
      const fetched = await findPostRecords(and(...referenceScope), {
        orderBy: CHRONO_DESC,
      });

      currentLevel = fetched.map((post) => ({
        post: post as unknown as RawPost,
        depth: nextIdMap.get(resolveId(post as unknown as RawPost)!) ?? depth + 1,
      }));
    } catch (error) {
      logger.error('[PostHydration] Failed to fetch referenced posts:', error);
      break;
    }
  }

  return result;
}

/**
 * Resolve a boost's DIRECT original post id (`boostOf`), if any. Unlike
 * {@link extractReferenceIds} this returns only the mandatory boost original
 * (never the optional quote/originalPostId references), so the forced
 * collection in {@link collectPostsWithDepth} pulls exactly the one post a
 * boost cannot render without.
 */
export function extractRepostOriginalId(post: RawPost): string | undefined {
  const value = post?.boostOf;
  if (!value) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const refId = obj._id ?? obj.id ?? obj.postId;
    if (refId) return String(refId);
  }
  return undefined;
}

export function extractReferenceIds(post: RawPost): string[] {
  const ids: string[] = [];
  const maybePush = (value: unknown) => {
    if (!value) return;
    if (typeof value === 'string') {
      ids.push(value);
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const refId = obj._id ?? obj.id ?? obj.postId;
      if (refId) {
        ids.push(String(refId));
      }
    }
  };

  maybePush(post.boostOf);
  maybePush(post.quoteOf);
  if (post.originalPostId) {
    maybePush(post.originalPostId);
  }
  return ids.filter(Boolean);
}

export function resolveId(post: RawPost): string {
  if (!post) return '';
  if (typeof post.id === 'string') return post.id;
  if (post._id) return String(post._id);
  return '';
}
