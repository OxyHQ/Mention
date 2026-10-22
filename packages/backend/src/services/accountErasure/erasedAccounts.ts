/**
 * The read side of the erasure ledger for request handlers: "has Oxy told us this
 * account was deleted?" A route asks here rather than reaching into the
 * repository (the layering rule in `scripts/validate-architecture-boundaries.mjs`).
 */

import {
  isAccountErased as ledgerHasAccount,
  isErasedUsername,
} from '../../db/accountErasures/accountErasureRepository';

/**
 * True from the moment a verified deletion event for the account is recorded,
 * even while the erasure is still running: the profile must stop being served
 * at once, not when the last batch commits.
 */
export async function isAccountErased(oxyUserId: string): Promise<boolean> {
  return ledgerHasAccount(oxyUserId);
}

/**
 * Is `/ap/users/<username>` a DELETED actor, to be answered `410 Gone` rather
 * than 404 (`@oxy.so/federation`'s `isActorGone`)? Asked only after the actor
 * routes found no federating account for the handle, so a handle someone has
 * claimed since is served as theirs. True from the moment the deletion event is recorded, for as
 * long as the ledger keeps the handle (`ERASURE_USERNAME_RETENTION_DAYS` after
 * the erasure completes), which outlasts the Delete's whole retry budget.
 */
export async function isErasedActorHandle(username: string): Promise<boolean> {
  return isErasedUsername(username);
}
