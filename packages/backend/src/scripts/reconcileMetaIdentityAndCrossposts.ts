/** Source-by-source Oxy projection repair; Mention never creates identity evidence. */
import { asc, gt, isNotNull, and } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { posts } from '../db/schema/posts';
import { lookupOxyIdentities, resolveOxyIdentity } from '../connectors/oxyIdentity';
import { reconcileActorIdentityProjection } from '../services/ActorIdentityProjectionService';
import { detectCrosspostEquivalence, reevaluateClusterForPost } from '../services/PostEquivalenceService';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { logger } from '../utils/logger';
const SCRIPT_NAME = 'reconcileMetaIdentityAndCrossposts';
export interface ReconciliationReport {
  actorsExamined: number;
  actorsChanged: number;
  postsChanged: number;
  authorshipConflicts: number;
  mutesPreserved: number;
  clustersDissolved: number;
  postsExamined: number;
  postClustersCreated: number;
  refused: Record<string, number>;
}
/** Full actor scan, keyset-paginated. Preview only LOOKS UP; it never resolves remotely. */
export async function reconcileMetaIdentityAndCrossposts(opts: { dryRun?: boolean } = {}): Promise<ReconciliationReport> {
  const dryRun = opts.dryRun ?? true;
  const report: ReconciliationReport = { actorsExamined: 0, actorsChanged: 0, postsChanged: 0, authorshipConflicts: 0, mutesPreserved: 0, clustersDissolved: 0, postsExamined: 0, postClustersCreated: 0, refused: {} };
  const refuse = (reason: string) => { report.refused[reason] = (report.refused[reason] ?? 0) + 1; };
  let cursor: string | undefined;
  while (true) {
    const actors = await getDb().select().from(federatedActors).where(cursor ? gt(federatedActors.id, cursor) : undefined).orderBy(asc(federatedActors.id)).limit(100);
    if (!actors.length) break;
    const known = dryRun ? await lookupOxyIdentities(actors.map(actor => actor.uri)) : [];
    for (const actor of actors) {
      report.actorsExamined++;
      try {
        const lookup = known.find(row => row.identifier === actor.uri);
        const reference = lookup?.externalIdentities.find(row => row.actorUri === actor.uri);
        const identity = dryRun
          ? (lookup?.userId && reference ? { ...reference, userId: lookup.userId } : undefined)
          : (await resolveOxyIdentity({ actorUri: actor.uri, transportAcct: actor.acct, protocol: actor.protocol })).externalIdentity;
        if (!identity) { refuse('oxy_identity_not_resolved'); continue; }
        const result = await reconcileActorIdentityProjection({ actorUri: actor.uri, oxyUserId: identity.userId, networkAcct: identity.canonicalAcct, dryRun });
        report.actorsChanged += Number(result.actorChanged);
        report.postsChanged += result.postsChanged;
        report.authorshipConflicts += result.authorshipConflicts;
        report.mutesPreserved += result.mutesPreserved;
        report.clustersDissolved += result.clustersDissolved;
        if (result.refusal) refuse(result.refusal);
      } catch (error) {
        refuse('oxy_resolution_or_projection_failed');
        logger.warn(`[${SCRIPT_NAME}] source refused`, { actorUri: actor.uri, reason: error instanceof Error ? error.message : 'unknown' });
      }
    }
    cursor = actors[actors.length - 1].id;
  }
  // Includes already-collapsed rows: a withdrawn/expired proof must reveal them.
  // This pass is bounded and independent of how many posts any one actor owns.
  let postCursor: string | undefined;
  while (true) {
    const rows = await getDb().select({ id: posts.id }).from(posts).where(and(isNotNull(posts.federationActorUri), postCursor ? gt(posts.id, postCursor) : undefined)).orderBy(asc(posts.id)).limit(100);
    if (!rows.length) break;
    for (const post of rows) {
      report.postsExamined++;
      if (dryRun) continue;
      await reevaluateClusterForPost(post.id);
      const decision = await detectCrosspostEquivalence({ postId: post.id });
      if (decision.outcome === 'clustered') report.postClustersCreated++;
      else if (decision.outcome === 'refused') refuse(decision.reason);
    }
    postCursor = rows[rows.length - 1].id;
  }
  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...report });
  return report;
}
async function main() {
  const dryRun = process.env.DRY_RUN !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  await reconcileMetaIdentityAndCrossposts({ dryRun });
}
if (require.main === module) void main().then(async () => { await closeAdminScriptResources(); process.exit(0); }).catch(async error => {
  logger.error(`[${SCRIPT_NAME}] failed`, { error });
  await closeAdminScriptResources().catch(() => undefined);
  process.exit(1);
});
