import { currentPrivateMembershipMedia } from './privateMedia';
import { and, eq, isNull } from 'drizzle-orm';
import type { RequestSafetyContext } from '../../utils/safetyRequester';
import { getDb } from '../../db/postgres';
import { membershipMedia } from '../../db/schema/memberships';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import {
  communityById,
  MembershipError,
  requireCommunityBenefit,
  type MembershipActor,
} from './access';
import { readableMembershipContent } from './content';

/** The original foreground requester travels to Oxy even when reading another member's file. */
function privateFiles(request: RequestSafetyContext) {
  if (
    !request.user ||
    !request.accessToken ||
    request.mcp ||
    request.capability ||
    request.serviceApp
  )
    throw new MembershipError(403, 'A foreground account session is required');
  return getServiceOxyClient().assets.withRequester({ requesterToken: request.accessToken });
}
export async function uploadMembershipMedia(
  communityId: string,
  actor: MembershipActor,
  request: RequestSafetyContext,
  bytes: Buffer,
  mime: string,
) {
  await requireCommunityBenefit(await communityById(communityId), actor, 'discussion_write');
  const { file } = await privateFiles(request).uploadAppFile(bytes, mime, {
    visibility: 'private',
  });
  // The application owns protected copies; the local author remains the member.
  // Personal files also permit supervised-owner contacts, so private user-owned
  // bytes cannot enforce this separate community entitlement. Dedup preserves visibility.
  if (file.visibility !== 'private')
    throw new MembershipError(
      409,
      'These bytes already exist as a public or unlisted application file',
    );
  const [media] = await getDb()
    .insert(membershipMedia)
    .values({
      communityId,
      ownerOxyUserId: actor.accountId,
      fileId: file.id,
      mime: file.mime,
      size: file.size,
    })
    .returning({ id: membershipMedia.id, mime: membershipMedia.mime, size: membershipMedia.size });
  return media;
}
export async function downloadMembershipMedia(
  contentId: string,
  mediaId: string,
  actor: MembershipActor,
  request: RequestSafetyContext,
) {
  const { row } = await readableMembershipContent(contentId, actor);
  await requireCommunityBenefit(await communityById(row.communityId), actor, 'media_download');
  const media = await currentPrivateMembershipMedia(contentId, mediaId);
  const files = await privateFiles(request).linkedDownloadUrls([media.fileId]);
  const file = files.find((entry) => entry.id === media.fileId);
  if (!file || !('visibility' in file) || file.visibility !== 'private')
    throw new MembershipError(404, 'Media is no longer available');
  // The network await can overlap membership revocation, account erasure or Files events.
  await readableMembershipContent(contentId, actor);
  await requireCommunityBenefit(await communityById(row.communityId), actor, 'media_download');
  const current = await currentPrivateMembershipMedia(contentId, mediaId);
  if (current.fileId !== media.fileId)
    throw new MembershipError(404, 'Media is no longer available');
  // Oxy owns the short TTL (currently300s). URLs are returned only here, never
  // persisted, cached, included in teasers, queued notifications or logged.
  return { url: file.url, expiresIn: file.expiresIn };
}

/** Discard a caller-owned upload draft and let the Oxy reference lifecycle retire unused application bytes. */
export async function discardMembershipMedia(
  communityId: string,
  mediaId: string,
  actor: MembershipActor,
): Promise<void> {
  const deleted = await getDb()
    .delete(membershipMedia)
    .where(
      and(
        eq(membershipMedia.id, mediaId),
        eq(membershipMedia.communityId, communityId),
        eq(membershipMedia.ownerOxyUserId, actor.accountId),
        isNull(membershipMedia.contentId),
      ),
    )
    .returning({ id: membershipMedia.id });
  if (!deleted.length) throw new MembershipError(404, 'Upload draft not found');
}
