// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Batched lookups for a reply's thread: recent repliers and the author of the post it answers. */
import type { SafetyDecision } from '@oxy.so/contracts';
import type { PostUser } from '@mention/shared-types';
import { logger } from '../../../utils/logger';
import { loadRecentReplierIds } from '../PostRecentReplierService';
import type { HydratedGraphNode, RawPost } from './types';
import { resolveId } from './graph';

/**
 * Phase 1: Read bounded replier user IDs without fetching their profiles.
 * Returns both per-post replier arrays and a flat set of all IDs.
 */
export async function loadRecentReplierProjection(postIds: string[]): Promise<{
  perPostRepliers: Map<string, string[]>;
  allReplierIds: Set<string>;
}> {
  const perPostRepliers = new Map<string, string[]>();
  const allReplierIds = new Set<string>();

  if (postIds.length === 0) return { perPostRepliers, allReplierIds };

  try {
    return await loadRecentReplierIds(postIds);
  } catch (error) {
    logger.warn('[PostHydration] Failed to load recent replier IDs:', error);
  }

  return { perPostRepliers, allReplierIds };
}

/**
 * For every post in the graph that IS a reply, the Oxy id of the author it
 * answers — when we hold that parent AND this viewer may read it.
 *
 * This is what makes reply context a property of the POST rather than of the
 * feed slice that happens to carry it. Every surface hydrates, so every surface
 * gets it: the feeds whose definition never opted into reply-context slicing,
 * the paths that emit no slices at all (the popular fallback, ordered feeds),
 * and the non-feed screens (search, saved, insights, the thread view) that
 * render a bare `HydratedPost`.
 *
 * Costs nothing when the page holds no replies — the common case for a
 * discovery lane — and at most ONE extra indexed `_id` lookup otherwise. The
 * authors themselves are NOT resolved here: their ids are merged into the
 * single {@link buildUserMap} batch the rest of hydration already runs, so a
 * parent author who is also a post author on the page costs no second fetch and
 * no second Oxy round trip.
 *
 * Membership of the returned map is the ACL decision. A parent that is absent,
 * unpublished, private, followers-only to a non-follower, restricted, or behind
 * a private profile yields NO entry, so the reply still reports itself as a
 * reply but names nobody — never a header naming the author of a post this
 * viewer was refused.
 *
 * `selfContinuationPostIds` is the SELF-THREAD decision, made here rather than
 * in the renderer for two reasons. It is the only place that holds both
 * authoritative author ids (`post.oxyUserId` and the parent's), and the DTO's
 * `user.id` is NOT a safe substitute: an orphan federated post carries a
 * degraded author summary whose `id` is the POST id (see `degradedActorSummary`
 * in `buildPostSummary`), so a renderer-side comparison would silently never
 * match for exactly those posts.
 */
export async function buildReplyParentAuthorMap(
  nodes: HydratedGraphNode[],
  additionalParents: RawPost[],
  safetyDecisions: Map<string, SafetyDecision>,
): Promise<{
  parentAuthorIdByPostId: Map<string, string>;
  parentAuthorIds: Set<string>;
  selfContinuationPostIds: Set<string>;
}> {
  const parentAuthorIdByPostId = new Map<string, string>();
  const parentAuthorIds = new Set<string>();
  const selfContinuationPostIds = new Set<string>();

  // The STORED `is_reply` column is the ONE definition of the concept (see
  // `derivesReplyIntent` in db/posts/postRecord.ts): it counts a federated
  // reply whose `inReplyTo` never resolved into a local `parentPostId`. Such a
  // reply has no parent to name but is still a reply, and `buildPostSummary`
  // emits its marker off the same column.
  const parentIdByPostId = new Map<string, string>();
  const replyAuthorIdByPostId = new Map<string, string>();
  for (const { post } of nodes) {
    if (!post || post.isReply !== true) continue;
    const postId = resolveId(post);
    const parentId = post.parentPostId ? String(post.parentPostId) : '';
    if (postId && parentId) {
      parentIdByPostId.set(postId, parentId);
      // The raw `oxyUserId`, not the DTO's `user.id` — see the note above.
      replyAuthorIdByPostId.set(postId, post.oxyUserId ? String(post.oxyUserId) : '');
    }
  }

  if (parentIdByPostId.size === 0) {
    return { parentAuthorIdByPostId, parentAuthorIds, selfContinuationPostIds };
  }

  // Parents already collected into the graph (a reply-context slice prepends
  // its parent, and a thread's own posts sit beside each other) are reused
  // rather than re-fetched.
  const knownById = new Map<string, RawPost>();
  for (const { post } of nodes) {
    const id = resolveId(post);
    if (id) knownById.set(id, post);
  }

  for (const parent of additionalParents) {
    const id = resolveId(parent);
    if (id) knownById.set(id, parent);
  }

  for (const [postId, parentId] of parentIdByPostId) {
    const parent = knownById.get(parentId);
    if (!parent || !safetyDecisions.get(parentId)?.allowed) continue;

    const parentAuthorId = parent.oxyUserId ? String(parent.oxyUserId) : '';
    // An orphan federated parent carries no Oxy author link, so there is
    // nobody to name — the reply keeps its marker and drops the handle.
    if (!parentAuthorId) continue;

    // A reply to one's OWN post is a self-thread continuation, which every
    // client renders as a thread (connector line + "Show this thread"), never
    // as a reply header — "Replying to @themselves" on every post after the
    // first is noise, and self-threads are a very common shape. Classified
    // here, where both ids are authoritative; `buildPostSummary` then omits
    // `replyContext` for these posts entirely, so the renderer needs no rule
    // and cannot mistake a self-continuation for an unnamed reply.
    const replyAuthorId = replyAuthorIdByPostId.get(postId);
    if (replyAuthorId && replyAuthorId === parentAuthorId) {
      selfContinuationPostIds.add(postId);
      continue;
    }

    parentAuthorIdByPostId.set(postId, parentAuthorId);
    parentAuthorIds.add(parentAuthorId);
  }

  return { parentAuthorIdByPostId, parentAuthorIds, selfContinuationPostIds };
}

/**
 * Phase 2: Build replier avatar map using the already-populated userMap.
 * No additional user profile fetches needed.
 */
export function buildReplierAvatarsFromUserMap(
  perPostRepliers: Map<string, string[]>,
  userMap: Map<string, PostUser>,
): Map<string, string[]> {
  const replierMap = new Map<string, string[]>();

  for (const [parentId, replierIds] of perPostRepliers) {
    const avatars: string[] = [];
    for (const replierId of replierIds) {
      const user = userMap.get(replierId);
      // Bare Oxy file id (or mirrored URL) — the client resolves it through
      // Bloom's ImageResolver, same as every other avatar.
      if (user?.avatar) {
        avatars.push(user.avatar);
      }
    }
    if (avatars.length > 0) {
      replierMap.set(parentId, avatars);
    }
  }

  return replierMap;
}
