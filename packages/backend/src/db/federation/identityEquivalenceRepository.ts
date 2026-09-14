/** Read-only access to retired Mention identity observations; never current proof. */
import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { federatedIdentityClaims } from '../schema/federation';
export async function listAttestedIdentityClaims(db: DatabaseOrTransaction = getDb()) {
  return db.select().from(federatedIdentityClaims).where(eq(federatedIdentityClaims.kind, 'first-party-link'));
}
