/**
 * Read access to an account list — the ONE definition of that rule.
 *
 * It used to be written out at each call site (`GET /lists/:id`, the list
 * timeline). That is exactly how `POST /entity-follows` came to subscribe a
 * viewer to a private list nobody would have let them read: the rule lived in
 * two places, and the third writer simply never got a copy. Everything that
 * reads or acts on a list answers to this function instead.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { accountLists } from '../db/schema/lists';

/**
 * The only two fields the visibility rule reads. Declared structurally so a
 * hydrated row, a projected row and a caller that assembled one by hand all
 * satisfy it.
 */
export interface ListVisibility {
  /**
   * Optional on purpose. `account_lists.is_public` is `NOT NULL DEFAULT true`,
   * so a row loaded from Postgres always carries it — but the rule below reads
   * `=== true`, and keeping the field optional is what makes "absent" fail
   * CLOSED for any caller that assembles a `ListVisibility` from somewhere
   * other than the table.
   */
  isPublic?: boolean;
  ownerOxyUserId: string;
}

/**
 * Whether `viewerId` may see `list`. A private list is owner-only; a viewer
 * with no id can only ever see public lists.
 *
 * Fails CLOSED on a value without `isPublic` — absent reads as private, which
 * is what `GET /lists/:id` has always done.
 */
export function canViewList(list: ListVisibility, viewerId: string | undefined): boolean {
  return list.isPublic === true || list.ownerOxyUserId === viewerId;
}

/**
 * Load just the fields `canViewList` needs.
 *
 * Returns null for a list that does not exist — including one named by an id of
 * any shape at all. The Mongoose version needed an `ObjectId.isValid` guard in
 * front of `findById` to keep a malformed id from throwing a `CastError`; a
 * `text` primary key simply matches no row, so the guard is deleted rather than
 * widened (see `db/MIGRATION-CONTRACT.md`).
 */
export async function loadListVisibility(listId: string): Promise<ListVisibility | null> {
  const [row] = await getDb()
    .select({ isPublic: accountLists.isPublic, ownerOxyUserId: accountLists.ownerOxyUserId })
    .from(accountLists)
    .where(eq(accountLists.id, listId))
    .limit(1);
  return row ?? null;
}
