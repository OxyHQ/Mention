import { and, eq } from 'drizzle-orm';
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
  const file = await privateFiles(request).uploadUserMedia(actor.accountId, bytes, mime, {
    visibility: 'private',
  });
  // Oxy deduplicates per owner and preserves existing visibility. Never convert
  // a public post's asset to private or pretend those existing public bytes are protected.
  if (file.visibility !== 'private')
    throw new MembershipError(
      409,
      'These bytes already exist as a public or unlisted file; use a private file',
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
  const [media] = await getDb()
    .select()
    .from(membershipMedia)
    .where(and(eq(membershipMedia.id, mediaId), eq(membershipMedia.contentId, contentId)))
    .limit(1);
  if (!media) throw new MembershipError(404, 'Media not found');
  const files = await privateFiles(request).linkedDownloadUrls([media.fileId]);
  const file = files.find((entry) => entry.id === media.fileId);
  if (!file) throw new MembershipError(404, 'Media is no longer available');
  // Oxy owns the short TTL (currently300s). URLs are returned only here, never
  // persisted, cached, included in teasers, queued notifications or logged.
  return { url: file.url, expiresIn: file.expiresIn };
}
