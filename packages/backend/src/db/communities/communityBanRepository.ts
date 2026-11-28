/**
 * `community_bans` — who a community hosted here refuses posts from.
 *
 * The primary key `(community, banned)` is the arbiter of "already banned", so
 * a repeated ban is a no-op rather than a read-then-write race.
 */

import { and, desc, eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { communityBans } from '../schema/communities';

export type CommunityBanRow = typeof communityBans.$inferSelect;

/** Whether `oxyUserId` is banned from `communityOxyUserId`. */
export async function isBannedFromCommunity(
  communityOxyUserId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: communityBans.bannedOxyUserId })
    .from(communityBans)
    .where(
      and(
        eq(communityBans.communityOxyUserId, communityOxyUserId),
        eq(communityBans.bannedOxyUserId, oxyUserId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Record a ban. False when the person was already banned. */
export async function insertCommunityBan(
  ban: Pick<
    CommunityBanRow,
    'communityOxyUserId' | 'bannedOxyUserId' | 'bannedByOxyUserId' | 'reason'
  >,
): Promise<boolean> {
  const inserted = await getDb()
    .insert(communityBans)
    .values(ban)
    .onConflictDoNothing()
    .returning({ id: communityBans.bannedOxyUserId });
  return inserted.length > 0;
}

/** Lift a ban. False when there was none. */
export async function deleteCommunityBan(
  communityOxyUserId: string,
  bannedOxyUserId: string,
): Promise<boolean> {
  const deleted = await getDb()
    .delete(communityBans)
    .where(
      and(
        eq(communityBans.communityOxyUserId, communityOxyUserId),
        eq(communityBans.bannedOxyUserId, bannedOxyUserId),
      ),
    )
    .returning({ id: communityBans.bannedOxyUserId });
  return deleted.length > 0;
}

/** A community's bans, newest first, bounded. */
export async function listCommunityBans(
  communityOxyUserId: string,
  limit: number,
): Promise<CommunityBanRow[]> {
  return getDb()
    .select()
    .from(communityBans)
    .where(eq(communityBans.communityOxyUserId, communityOxyUserId))
    .orderBy(desc(communityBans.createdAt))
    .limit(limit);
}
