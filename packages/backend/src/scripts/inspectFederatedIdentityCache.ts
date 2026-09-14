/** Exact, read-only evidence before public discovery; never fetches an actor or Oxy profile. */
import { sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../db/postgres';

export interface CacheInspectionInput {
  actorUri: string;
  canonicalAcct: string;
  transportAcct: string;
}
export function validateCacheInspectionInput(input: CacheInspectionInput): CacheInspectionInput {
  const acct = /^[a-z0-9._-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;
  if (![input.canonicalAcct, input.transportAcct].every(value => typeof value === 'string' && value.length <= 320 && acct.test(value))) {
    throw new Error('Exact lowercase canonical and transport accts are required');
  }
  if (typeof input.actorUri !== 'string' || input.actorUri.length > 2048 || !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9/._~%@:+-]+$/.test(input.actorUri)) {
    throw new Error('An exact public HTTPS actor URI is required');
  }
  const uri = new URL(input.actorUri);
  if (!uri.hostname.includes('.') || !/[a-z]$/.test(uri.hostname) || uri.hostname.endsWith('.localhost') || uri.hostname === 'localhost' || uri.username || uri.password || uri.port) {
    throw new Error('An exact public HTTPS actor URI is required');
  }
  return { actorUri: input.actorUri, canonicalAcct: input.canonicalAcct, transportAcct: input.transportAcct };
}

export async function inspectFederatedIdentityCache(raw: CacheInspectionInput) {
  const input = validateCacheInspectionInput(raw);
  return getDb().transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '15s'`);
    const [row] = await tx.execute<{
      observedAt: Date;
      actorUriMatches: number;
      canonicalAcctMatches: number;
      transportAcctMatches: number;
      postSourceMatches: number;
    }>(sql`select transaction_timestamp() as "observedAt",
      (select count(*)::int from federated_actors where uri = ${input.actorUri}) as "actorUriMatches",
      (select count(*)::int from federated_actors where acct = ${input.canonicalAcct} or network_acct = ${input.canonicalAcct}) as "canonicalAcctMatches",
      (select count(*)::int from federated_actors where acct = ${input.transportAcct} or network_acct = ${input.transportAcct}) as "transportAcctMatches",
      (select count(*)::int from posts where federation_actor_uri = ${input.actorUri}) as "postSourceMatches"`);
    return { operation: 'inspect_cache' as const, dryRun: true as const, identifiers: input, observedAt: new Date(row.observedAt).toISOString(),
      actorUriMatches: row.actorUriMatches, canonicalAcctMatches: row.canonicalAcctMatches,
      transportAcctMatches: row.transportAcctMatches, postSourceMatches: row.postSourceMatches };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

async function main() {
  const input = validateCacheInspectionInput({ actorUri: process.env.INSPECT_ACTOR_URI ?? '', canonicalAcct: process.env.INSPECT_CANONICAL_ACCT ?? '', transportAcct: process.env.INSPECT_TRANSPORT_ACCT ?? '' });
  await connectPostgres();
  const report = await inspectFederatedIdentityCache(input);
  // Public selectors bind the snapshot to its candidate; no profile/post data is returned.
  console.log(JSON.stringify({ msg: '[inspectFederatedIdentityCache] complete', ...report }));
}
if (require.main === module) void main().then(async () => { await closePostgres(); process.exit(0); }).catch(async () => {
  console.error('Federated cache inspection failed; no valid absence report was produced');
  await closePostgres().catch(() => undefined);
  process.exit(1);
});
