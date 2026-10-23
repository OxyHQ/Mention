import { loadPostRecord } from '../db/posts/postRepository';
import { UserPrivacyManager } from '../mtn/UserPrivacyManager';
import { postHydrationService, type HydrationOptions } from './PostHydrationService';

type EngagementRequester = Pick<HydrationOptions, 'viewerId' | 'oxyClient'> &
  Required<Pick<HydrationOptions, 'safetyRequester'>>;

/** Authorize the subject before disclosing activity; reuse privacy for actor exclusions. */
export async function loadPostEngagementAudience(
  postId: string,
  requester: EngagementRequester,
): Promise<Set<string> | null> {
  const { viewerId, oxyClient } = requester;
  const [post, privacy] = await Promise.all([
    loadPostRecord(postId),
    viewerId
      ? UserPrivacyManager.loadPrivacyState(viewerId, { oxyClient, includeRestricted: true })
      : undefined,
  ]);
  if (!post || (post.oxyUserId && privacy?.excludedUserIds.has(post.oxyUserId))) return null;
  const [visible] = await postHydrationService.hydratePosts([post], {
    ...requester,
    maxDepth: 0,
    viewerPrivacy: privacy
      ? { blockedIds: [...privacy.blockedUserIds], restrictedIds: [...privacy.restrictedUserIds] }
      : undefined,
  });
  return visible ? (privacy?.excludedUserIds ?? new Set()) : null;
}
