/**
 * `actor_key_pairs` — the RSA keypair that used to sign a local user's outbound
 * ActivityPub requests.
 *
 * Nothing in the request path reads this table any more: signing is custodial in
 * oxy-api (`connectors/activitypub/crypto.ts` calls `signViaOxy`, and the private
 * key never enters Mention). What remains is account lifecycle — the deletion
 * preflight has to SEE a leftover row before it lets an account be removed, and
 * the purge script has to remove it — so the two operations here are exactly
 * those, and no read ever returns `private_key_pem`.
 */

import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { actorKeyPairs } from '../schema/federation';

/**
 * Whether a keypair row still exists for this Oxy account.
 *
 * Selects the id ALONE. `private_key_pem` is a protected column
 * (`db/schema/protectedColumns.ts`) and a `select()` with no projection returns
 * every column in drizzle — so an existence check written the obvious way would
 * pull a private key across the wire to answer a boolean.
 */
export async function hasActorKeyPair(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: actorKeyPairs.id })
    .from(actorKeyPairs)
    .where(eq(actorKeyPairs.oxyUserId, oxyUserId))
    .limit(1);
  return rows.length > 0;
}

/** Remove the keypair of one Oxy account. Returns the number of rows removed. */
export async function deleteActorKeyPair(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const deleted = await db
    .delete(actorKeyPairs)
    .where(eq(actorKeyPairs.oxyUserId, oxyUserId))
    .returning({ id: actorKeyPairs.id });
  return deleted.length;
}
