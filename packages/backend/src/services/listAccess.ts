/**
 * Read access to an account list — the ONE definition of that rule.
 *
 * It used to be written out at each call site (`GET /lists/:id`, the list
 * timeline). That is exactly how `POST /entity-follows` came to subscribe a
 * viewer to a private list nobody would have let them read: the rule lived in
 * two places, and the third writer simply never got a copy. Everything that
 * reads or acts on a list answers to this function instead.
 */

import mongoose from 'mongoose';
import AccountList from '../models/AccountList';

/**
 * The only two fields the visibility rule reads. Declared structurally so a
 * hydrated document, a `.lean()` row and a projected row all satisfy it.
 */
export interface ListVisibility {
  /** Optional: `.lean()` bypasses the schema default, so a row could lack it. */
  isPublic?: boolean;
  ownerOxyUserId: string;
}

/**
 * Whether `viewerId` may see `list`. A private list is owner-only; a viewer
 * with no id can only ever see public lists.
 *
 * Fails CLOSED on a row stored without `isPublic` — absent reads as private,
 * which is what `GET /lists/:id` has always done.
 */
export function canViewList(list: ListVisibility, viewerId: string | undefined): boolean {
  return list.isPublic === true || list.ownerOxyUserId === viewerId;
}

/**
 * Load just the fields `canViewList` needs.
 *
 * Returns null both for a list that does not exist and for a malformed id:
 * `findById` throws a CastError on a non-ObjectId string, and a caller
 * enforcing access wants "no such list", not a 500.
 */
export async function loadListVisibility(listId: string): Promise<ListVisibility | null> {
  if (!mongoose.Types.ObjectId.isValid(listId)) return null;
  return AccountList.findById(listId).select('isPublic ownerOxyUserId').lean<ListVisibility>();
}
