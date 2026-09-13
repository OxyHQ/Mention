/** Retired identity-authority writer. Existing rows remain readable audit history. */
import { connectPostgres } from '../db/postgres';
import { listAttestedIdentityClaims } from '../db/federation/identityEquivalenceRepository';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { logger } from '../utils/logger';
export interface AttestationInput {
  identityA: string;
  identityB: string;
  source: string;
  remove?: boolean;
  dryRun?: boolean;
}
export interface AttestationOutcome {
  applied: false;
  refusal: 'oxy_identity_authority_required';
  rows: 0;
}
/** Neither registration nor removal may mint person equivalence inside Mention. */
export async function recordAttestedIdentityLink(_input: AttestationInput): Promise<AttestationOutcome> {
  return { applied: false, refusal: 'oxy_identity_authority_required', rows: 0 };
}
async function main() {
  if (process.env.DRY_RUN === 'false') throw new Error('Mention identity attestations are retired; reconcile verified source identities through Oxy');
  await connectPostgres();
  logger.info('[recordAttestedIdentityLink] retired writer; historical audit only', { historicalClaims: (await listAttestedIdentityClaims()).length });
}
if (require.main === module) void main().then(async () => { await closeAdminScriptResources(); process.exit(0); }).catch(async error => {
  logger.error('[recordAttestedIdentityLink] refused', { error });
  await closeAdminScriptResources().catch(() => undefined);
  process.exit(1);
});
