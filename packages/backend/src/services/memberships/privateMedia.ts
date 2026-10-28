import { and, eq, exists } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { membershipMedia, membershipReports } from '../../db/schema/memberships';
import { oxyFileStates } from '../../db/schema/oxyFiles';
import { MembershipError } from './errors';

/** Re-read after a remote URL mint too: local erasure/revocation can race its response. */
export async function currentPrivateMembershipMedia(
  contentId: string,
  mediaId: string,
  db: DatabaseOrTransaction = getDb(),
  reportId?: string,
) {
  // One SQL snapshot checks media, file state and (for review) the report binding.
  const [current] = await db
    .select({ media: membershipMedia, state: oxyFileStates })
    .from(membershipMedia)
    .leftJoin(oxyFileStates, eq(oxyFileStates.fileId, membershipMedia.fileId))
    .where(
      and(
        eq(membershipMedia.id, mediaId),
        eq(membershipMedia.contentId, contentId),
        reportId
          ? exists(
              db
                .select({ id: membershipReports.id })
                .from(membershipReports)
                .where(
                  and(
                    eq(membershipReports.id, reportId),
                    eq(membershipReports.contentId, membershipMedia.contentId),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .limit(1);
  if (!current) throw new MembershipError(404, 'Media not found');
  const { media, state } = current;
  if (state && (state.status !== 'active' || state.visibility !== 'private'))
    throw new MembershipError(404, 'Media is no longer available');
  return media;
}
