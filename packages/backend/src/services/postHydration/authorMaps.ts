/** Batched lookups keyed by author: the user summaries, their privacy, signing channels and disclosed writers. */
import type { PostUser } from '@mention/shared-types';
import type { PostRecordFederation } from '../../db/posts/postRecord';
import { loadSigningChannelIds } from '../channelWriterDisclosure';
import { logger } from '../../utils/logger';
import { DEFAULT_PRIVACY, readEngagementCountPrivacy } from '../engagementCountPrivacy';
import { collectAuthorshipUserIds } from '../../utils/postAuthorship';
import { normalizeMentionIds } from '../../utils/textProcessing';
import type { ExtendedViewerContext, HydratedGraphNode, ViewerContext } from './types';
import { resolveOrphanFederatedAuthors, resolveUserSummaries } from './userSummaries';
import { resolveId } from './graph';
import { loadPrivacySettings } from './viewerContext';

/**
 * The channel accounts in this page that DISCLOSE their writers.
 *
 * Only posts that actually carry a `writtenByOxyUserId` contribute a
 * candidate, so an ordinary page of posts asks about nothing and
 * {@link loadSigningChannelIds} skips its query entirely.
 *
 * The decision itself — including the fail-closed reading of
 * `channelAccount.signPosts` — belongs to `services/channelWriterDisclosure`, which
 * the channel's writers list reads too. Hydration collects the candidates; it
 * does not decide.
 */
export async function buildSigningChannelIds(nodes: HydratedGraphNode[]): Promise<Set<string>> {
  const candidateAuthorIds = new Set<string>();
  for (const { post } of nodes) {
    if (typeof post?.writtenByOxyUserId !== 'string' || post.writtenByOxyUserId.length === 0) {
      continue;
    }
    const authorId = post.oxyUserId ? String(post.oxyUserId) : '';
    if (authorId) candidateAuthorIds.add(authorId);
  }

  return loadSigningChannelIds(candidateAuthorIds);
}

/**
 * The writer ids this page will actually DISCLOSE — merged into the single
 * `buildUserMap` batch so a disclosed writer resolves through the ordinary
 * identity path, exactly like any other author.
 *
 * Gated on the settings answer rather than on the column, so an undisclosed
 * writer is not resolved, not cached, and cannot reach a DTO by accident. The
 * remaining condition — that the author really is a `channel` account — is
 * checked at byline time, where the resolved `user.kind` is known.
 */
export function collectDisclosedWriterIds(
  nodes: HydratedGraphNode[],
  signingChannelIds: Set<string>,
): Set<string> {
  const writerIds = new Set<string>();
  if (signingChannelIds.size === 0) return writerIds;

  for (const { post } of nodes) {
    const writerId = typeof post?.writtenByOxyUserId === 'string' ? post.writtenByOxyUserId : '';
    const authorId = post?.oxyUserId ? String(post.oxyUserId) : '';
    if (writerId && authorId && signingChannelIds.has(authorId)) {
      writerIds.add(writerId);
    }
  }
  return writerIds;
}

export async function buildUserMap(
  nodes: HydratedGraphNode[],
  extraLocalUserIds?: Set<string>,
): Promise<Map<string, PostUser>> {
  const userIds = new Set<string>();

  for (const { post } of nodes) {
    for (const userId of collectAuthorshipUserIds(post?.authorship)) {
      userIds.add(userId);
    }
    // Mentions are known before identity resolution; include them in the
    // author batch instead of adding a second remote round trip per page.
    for (const mentionId of normalizeMentionIds(post?.mentions ?? [])) {
      userIds.add(mentionId);
    }
  }

  // Merge in extra user IDs (e.g., replier IDs) for batch fetching
  if (extraLocalUserIds) {
    for (const id of extraLocalUserIds) {
      userIds.add(id);
    }
  }

  // `resolveUserSummaries` returns raw Oxy users (Oxy owns identity) and
  // already enriches any degraded FEDERATED author from the federated_actors
  // record — no separate repair step here.
  const resolved = await resolveUserSummaries([...userIds]);

  const userMap = new Map<string, PostUser>();
  for (const [userId, value] of resolved) {
    userMap.set(userId, value.user);
  }

  return userMap;
}

/**
 * Resolve a degraded author (keyed by post id) for every FEDERATED post in the
 * graph whose Oxy author link is missing — a legacy orphan. Native null-author
 * posts are intentionally skipped: they carry no `federation` data and are a
 * genuine data error that {@link buildPostSummary} drops. See
 * {@link resolveOrphanFederatedAuthors} for the derivation.
 */
export async function buildOrphanFederatedAuthorMap(
  nodes: HydratedGraphNode[],
): Promise<Map<string, PostUser>> {
  const orphans: Array<{ postId: string; federation: PostRecordFederation }> = [];
  for (const { post } of nodes) {
    if (post?.oxyUserId || !post?.federation) continue;
    const postId = resolveId(post);
    if (!postId) continue;
    orphans.push({ postId, federation: post.federation });
  }
  return resolveOrphanFederatedAuthors(orphans);
}

export async function buildAuthorPrivacyMap(
  nodes: HydratedGraphNode[],
  viewerContext?: ViewerContext,
): Promise<Map<string, typeof DEFAULT_PRIVACY>> {
  // Use pre-fetched cache from buildViewerContext if available
  const cached = (viewerContext as ExtendedViewerContext)?._authorPrivacyCache;
  if (cached && cached.size > 0) {
    // Ensure all authors in current nodes are covered (some may be from depth>0 fetches)
    const authorIds = Array.from(
      new Set(
        nodes
          .map(({ post }) => post?.oxyUserId)
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    );
    const missingIds = authorIds.filter((id) => !cached.has(id));
    if (missingIds.length === 0) {
      return cached;
    }

    // Fetch only missing authors
    try {
      const settings = await loadPrivacySettings(missingIds);
      for (const setting of settings) {
        cached.set(setting.oxyUserId, readEngagementCountPrivacy(setting));
      }
      for (const id of missingIds) {
        if (!cached.has(id)) cached.set(id, { ...DEFAULT_PRIVACY });
      }
    } catch (error) {
      logger.warn('[PostHydration] Failed to load missing author privacy settings:', error);
      for (const id of missingIds) cached.set(id, { ...DEFAULT_PRIVACY });
    }
    return cached;
  }

  // Fallback: no cache available, fetch all
  const authorIds = Array.from(
    new Set(
      nodes
        .map(({ post }) => post?.oxyUserId)
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  );

  const privacyMap = new Map<string, typeof DEFAULT_PRIVACY>();
  if (authorIds.length === 0) {
    return privacyMap;
  }

  try {
    const settings = await loadPrivacySettings(authorIds);
    settings.forEach((setting) => {
      privacyMap.set(setting.oxyUserId, readEngagementCountPrivacy(setting));
    });

    authorIds.forEach((authorId) => {
      if (!privacyMap.has(authorId)) {
        privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
      }
    });
  } catch (error) {
    logger.warn('[PostHydration] Failed to load author privacy settings:', error);
    authorIds.forEach((authorId) => {
      privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
    });
  }

  return privacyMap;
}
