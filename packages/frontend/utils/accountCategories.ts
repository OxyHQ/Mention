import { ACCOUNT_CATEGORY_IDS, type AccountCategoryId } from '@oxy.so/contracts';

/**
 * An account's categories — what a channel, organization, project or bot IS.
 *
 * The whole model rests on ONE fact, and every function here exists to keep it:
 * the stored value is an ORDERED list of ids, and **element 0 is the primary
 * category**. There is deliberately no sibling `primaryCategory` field at Oxy,
 * because two representations of one fact can disagree — so nothing here may
 * sort, and nothing may reorder a list on its way to a renderer.
 *
 * The values are IDS, never labels, which is what lets the READER's language win
 * over the writer's: `useAccountCategoryLabel` names each id with Oxy's own
 * labels (`accountCategoryLabel` in `@oxy.so/core`).
 */

/**
 * The ids this build can NAME.
 *
 * A stored id can legitimately be one this build has never heard of — the
 * vocabulary lives at Oxy and grows there, so an older client will meet a newer
 * id, and the account is not wrong for having it. The set is what separates
 * "renders as its label" from "cannot be named here", and it is a `Set` because
 * every list read below tests membership per element.
 *
 * A RETIRED id is still a known one: withdrawal removes an id from
 * `SELECTABLE_ACCOUNT_CATEGORY_IDS` — so no picker offers it again — but leaves
 * it in `ACCOUNT_CATEGORY_IDS`, so an account that already carries one keeps
 * displaying it normally. Retired and unknown are therefore NOT the same case,
 * and only the second one has no label.
 */
const KNOWN_ACCOUNT_CATEGORY_IDS: ReadonlySet<string> = new Set(ACCOUNT_CATEGORY_IDS);

/** Whether this build can put a label on `id`. */
export function isKnownAccountCategoryId(id: string): id is AccountCategoryId {
  return KNOWN_ACCOUNT_CATEGORY_IDS.has(id);
}

/**
 * The PRIMARY category to display, or `null` when there is none to name.
 *
 * When element 0 is an id this build cannot name, the answer is `null` — it is
 * NOT the next element. The profile line means "this account's primary
 * category", so filling it with a category that is merely one the account also
 * has would state something false, quietly, and only on clients old enough to
 * hit it. Showing nothing is incomplete; showing the second is wrong.
 */
export function primaryAccountCategoryId(
  ids: readonly string[] | undefined,
): AccountCategoryId | null {
  const primary = ids?.[0];
  return primary !== undefined && isKnownAccountCategoryId(primary) ? primary : null;
}

/**
 * Every stored id this build can name, in STORED ORDER.
 *
 * Filters, never sorts: the order carries the primary, so re-ordering here would
 * destroy the one piece of information the list encodes.
 */
export function nameableAccountCategoryIds(
  ids: readonly string[] | undefined,
): AccountCategoryId[] {
  return (ids ?? []).filter(isKnownAccountCategoryId);
}
