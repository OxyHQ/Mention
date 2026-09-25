/**
 * The read side of the erasure ledger for request handlers: "has Oxy told us this
 * account was deleted?" A route asks here rather than reaching into the
 * repository (the layering rule in `scripts/validate-architecture-boundaries.mjs`).
 */

import { isAccountErased as ledgerHasAccount } from '../../db/accountErasures/accountErasureRepository';

/**
 * True from the moment a verified deletion event for the account is recorded,
 * even while the erasure is still running: the profile must stop being served
 * at once, not when the last batch commits.
 */
export async function isAccountErased(oxyUserId: string): Promise<boolean> {
  return ledgerHasAccount(oxyUserId);
}
