import { and, asc, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { membershipMedia } from '../../db/schema/memberships';

/** Upload drafts are session work, not persisted composer drafts or billing grace. */
export const MEMBERSHIP_UPLOAD_DRAFT_TTL_HOURS = 24;
const EXPIRY_BATCH_SIZE = 500;

/** Release only abandoned references. Oxy owns file trash/collection, including shared copies. */
export async function expireMembershipMediaDrafts(
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [clock] = await db.execute<{ now: string | Date }>(sql`select clock_timestamp() as now`);
  if (!clock) throw new Error('Database clock unavailable');
  const cutoff = new Date(
    new Date(clock.now).getTime() - MEMBERSHIP_UPLOAD_DRAFT_TTL_HOURS * 60 * 60 * 1000,
  );
  const eligible = and(isNull(membershipMedia.contentId), lt(membershipMedia.createdAt, cutoff));
  let removed = 0;
  for (;;) {
    const candidates = db
      .select({ id: membershipMedia.id })
      .from(membershipMedia)
      .where(eligible)
      .orderBy(asc(membershipMedia.createdAt), asc(membershipMedia.id))
      .limit(EXPIRY_BATCH_SIZE);
    const expired = await db
      .delete(membershipMedia)
      // Recheck after any concurrent attachment's row lock: selection alone is not authority to delete.
      .where(and(eligible, inArray(membershipMedia.id, candidates)))
      .returning({ id: membershipMedia.id });
    removed += expired.length;
    if (expired.length < EXPIRY_BATCH_SIZE) return removed;
  }
}
