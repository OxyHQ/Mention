import type { OxyAuthRequest } from '@oxy.so/core/server';
import { loadPostRecord } from '../../db/posts/postRepository';
import { loadUserSettings } from '../../db/userProfile/userSettingsRepository';
import { canRequestReadPost } from '../postReadAccess';
import { isAccountErased } from '../accountErasure/erasedAccounts';
import { callerOxyUser, createScopedOxyClient } from '../../utils/oxyHelpers';
import { canViewProfileDesign } from '../../utils/privacyHelpers';
import type { CommerceMetricTarget } from './metrics';

export async function canReadAccount(req: OxyAuthRequest, accountId: string): Promise<boolean> {
  const [erased, settings] = await Promise.all([
    isAccountErased(accountId),
    loadUserSettings(accountId),
  ]);
  if (erased) return false;
  if (req.user?.id && req.user.id !== accountId) {
    const caller = callerOxyUser(req);
    // This caller-scoped relationship API checks blocks in both directions.
    if (!caller || (await caller.privacy.isBlocked(accountId))) return false;
  }
  return canViewProfileDesign(
    accountId,
    req.user?.id,
    settings?.privacy?.profileVisibility,
    createScopedOxyClient(req),
  );
}

export async function resolveReadableCommercePost(
  req: OxyAuthRequest,
  postId: string,
): Promise<{ target: CommerceMetricTarget; ownerId: string } | null> {
  const post = await loadPostRecord(postId);
  if (!post?.oxyUserId || !post.content.commerce?.length || post.status !== 'published')
    return null;
  if (!(await canRequestReadPost(req, post.id))) return null;
  return { target: { kind: 'post', id: post.id }, ownerId: post.oxyUserId };
}
