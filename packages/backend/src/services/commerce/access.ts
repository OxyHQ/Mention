import type { OxyAuthRequest } from '@oxy.so/core/server';
import { loadPostRecord } from '../../db/posts/postRepository';
import { loadUserSettings } from '../../db/userProfile/userSettingsRepository';
import { canRequestReadPost } from '../postReadAccess';
import { isAccountErased } from '../accountErasure/erasedAccounts';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import { blockedEitherWay, canViewProfileDesign } from '../../utils/privacyHelpers';
import { safetyRequesterFor } from '../../utils/safetyRequester';
import type { CommerceMetricTarget } from './metrics';

export async function canReadAccount(req: OxyAuthRequest, accountId: string): Promise<boolean> {
  const [erased, settings] = await Promise.all([
    isAccountErased(accountId),
    loadUserSettings(accountId),
  ]);
  if (erased) return false;
  if (req.user?.id && req.user.id !== accountId) {
    // A block in either direction hides the account. A failed check rejects,
    // never read as "no block".
    if ((await blockedEitherWay(safetyRequesterFor(req), [accountId])).has(accountId)) return false;
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
