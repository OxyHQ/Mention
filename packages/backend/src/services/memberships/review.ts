import { currentPrivateMembershipMedia } from './privateMedia';
import {
  OxyAppPermissionError,
  appPermissionErrorStatus,
  type OxyAuthRequest,
} from '@oxy.so/core/server';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { membershipReviewAudits } from '../../db/schema/membershipModeration';
import {
  membershipCommunities,
  membershipContents,
  membershipMedia,
  membershipPollOptions,
  membershipReports,
} from '../../db/schema/memberships';
import { MEMBERSHIP_MODERATION_PERMISSION } from '../../runtime/applicationPermissions';
import { getRuntimeOxyClient } from '../../runtime/oxyClient';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import type { RequestSafetyContext } from '../../utils/safetyRequester';
import { MembershipError } from './errors';

type ReviewRequest = OxyAuthRequest & RequestSafetyContext;
type ReviewAction = typeof membershipReviewAudits.$inferInsert.action;

async function reviewer(req: ReviewRequest): Promise<string> {
  if (
    !req.user ||
    !req.accessToken ||
    !req.sessionId ||
    !req.userId ||
    req.mcp ||
    req.capability ||
    req.serviceApp ||
    req.serviceActingAs
  )
    throw new MembershipError(403, 'A foreground operator session is required');
  const applicationId = config.identity.serviceApplicationId;
  const held = await getRuntimeOxyClient()
    .appPermissionsFor(req, { applicationId, fresh: true })
    .catch((error: unknown) => {
      if (error instanceof OxyAppPermissionError)
        throw new MembershipError(
          appPermissionErrorStatus(error, 403),
          'Membership review authority unavailable',
        );
      throw error;
    });
  if (
    held.applicationId !== applicationId ||
    !held.operatorId ||
    !held.has(MEMBERSHIP_MODERATION_PERMISSION)
  )
    throw new MembershipError(403, 'Membership review permission required');
  return held.operatorId;
}

async function boundReport(db: DatabaseOrTransaction, reportId: string, communityId: string) {
  const [bound] = await db
    .select({ report: membershipReports, content: membershipContents })
    .from(membershipReports)
    .innerJoin(membershipContents, eq(membershipContents.id, membershipReports.contentId))
    .where(and(eq(membershipReports.id, reportId), eq(membershipContents.communityId, communityId)))
    .limit(1);
  if (!bound) throw new MembershipError(404, 'Report not found');
  return bound;
}

/** The report binds an immutable body: membership content has no edit operation.
 * Erasure still deletes it; moderation retains a removed body only until that erasure.
 * Audit commits before any evidence is returned. Reporter identity is never exposed.
 */
export async function inspectMembershipReport(
  communityId: string,
  reportId: string,
  req: ReviewRequest,
  purpose: string,
) {
  const operatorOxyUserId = await reviewer(req);
  return getDb().transaction(async (tx) => {
    const { report, content } = await boundReport(tx, reportId, communityId);
    await tx
      .insert(membershipReviewAudits)
      .values({ reportId, operatorOxyUserId, action: 'inspect', purpose });
    const media = await tx
      .select({ id: membershipMedia.id, mime: membershipMedia.mime, size: membershipMedia.size })
      .from(membershipMedia)
      .where(eq(membershipMedia.contentId, content.id));
    const options = await tx
      .select({
        id: membershipPollOptions.id,
        text: membershipPollOptions.text,
        position: membershipPollOptions.position,
      })
      .from(membershipPollOptions)
      .where(eq(membershipPollOptions.contentId, content.id))
      .orderBy(membershipPollOptions.position);
    return {
      report: {
        id: report.id,
        reason: report.reason,
        createdAt: report.createdAt,
        resolvedAt: report.resolvedAt,
      },
      content: {
        id: content.id,
        communityId,
        kind: content.kind,
        title: content.title,
        body: content.body,
        createdAt: content.createdAt,
        removedAt: content.removedAt,
        media,
        options,
      },
    };
  });
}

export async function reviewMembershipReportMedia(
  communityId: string,
  reportId: string,
  mediaId: string,
  req: ReviewRequest,
  purpose: string,
) {
  const operatorOxyUserId = await reviewer(req);
  const media = await getDb().transaction(async (tx) => {
    const { content } = await boundReport(tx, reportId, communityId);
    const row = await currentPrivateMembershipMedia(content.id, mediaId, tx);
    await tx
      .insert(membershipReviewAudits)
      .values({ reportId, operatorOxyUserId, action: 'download_media', purpose });
    return row;
  });
  // The operator's real session accompanies the owning app; no creator impersonation.
  if (!req.accessToken) throw new MembershipError(403, 'Original operator session required');
  const files = await getServiceOxyClient()
    .assets.withRequester({ requesterToken: req.accessToken })
    .linkedDownloadUrls([media.fileId]);
  const file = files.find((item) => item.id === media.fileId);
  if (!file || file.visibility !== 'private')
    throw new MembershipError(404, 'Media is no longer available');
  // Revalidate all local authority after the network await; never hold a transaction across it.
  await reviewer(req);
  const { content } = await boundReport(getDb(), reportId, communityId);
  const current = await currentPrivateMembershipMedia(content.id, mediaId, getDb(), reportId);
  if (current.fileId !== media.fileId)
    throw new MembershipError(404, 'Media is no longer available');
  return { url: file.url, expiresIn: file.expiresIn };
}

export async function actOnMembershipReport(
  communityId: string,
  reportId: string,
  req: ReviewRequest,
  action: Exclude<ReviewAction, 'inspect' | 'download_media'>,
  purpose: string,
) {
  const operatorOxyUserId = await reviewer(req);
  await getDb().transaction(async (tx) => {
    const { content } = await boundReport(tx, reportId, communityId);
    await tx
      .insert(membershipReviewAudits)
      .values({ reportId, operatorOxyUserId, action, purpose });
    if (action === 'remove_content')
      await tx
        .update(membershipContents)
        .set({ removedAt: new Date(), updatedAt: new Date() })
        .where(eq(membershipContents.id, content.id));
    if (action === 'suspend_community')
      await tx
        .update(membershipCommunities)
        .set({ status: 'suspended', updatedAt: new Date() })
        .where(eq(membershipCommunities.id, communityId));
    await tx
      .update(membershipReports)
      .set({ resolvedAt: new Date() })
      .where(eq(membershipReports.id, reportId));
  });
}
