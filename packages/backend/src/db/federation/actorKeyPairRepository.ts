/**
 * `actor_key_pairs` — the public half of the RSA key a local user's outbound
 * ActivityPub requests are signed with.
 *
 * Nothing in the request path reads this table any more: signing is custodial in
 * oxy-api (`connectors/activitypub/crypto.ts` calls `signViaOxy`, and the private
 * key never enters Mention — migration 0061 dropped the plaintext copy). What
 * remains is the local-actor marker and account lifecycle — the deletion
 * preflight has to SEE a leftover row before it lets an account be removed, and
 * the purge script has to remove it — so the operations here are exactly those.
 */

import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { actorKeyPairs } from '../schema/federation';

/** Whether a keypair row still exists for this Oxy account. Selects the id alone. */
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
