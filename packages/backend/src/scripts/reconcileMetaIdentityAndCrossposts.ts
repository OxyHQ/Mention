/** Source-by-source Oxy projection repair; Mention never creates identity evidence. */
import { asc, gt, eq, and } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { posts } from '../db/schema/posts';
import { lookupOxyIdentities, resolveOxyIdentity } from '../connectors/oxyIdentity';
import { createActorProjectionCacheBatch, reconcileActorIdentityProjection } from '../services/ActorIdentityProjectionService';
import { crosspostReconciliationPostSql, detectCrosspostEquivalence, reevaluateClusterForPost } from '../services/PostEquivalenceService';
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
/** Full actor scan using fresh Oxy authority; only apply resolves unknown sources. */
export async function reconcileMetaIdentityAndCrossposts(opts: { dryRun?: boolean } = {}): Promise<ReconciliationReport> {
  const dryRun = opts.dryRun ?? true;
  const report: ReconciliationReport = { actorsExamined: 0, actorsChanged: 0, postsChanged: 0, authorshipConflicts: 0, mutesPreserved: 0, clustersDissolved: 0, postsExamined: 0, postClustersCreated: 0, refused: {} };
  const refuse = (reason: string) => { report.refused[reason] = (report.refused[reason] ?? 0) + 1; };
  const cacheBatch = createActorProjectionCacheBatch();
  try {
    let actorBatchesCompleted = 0;
    let cursor: string | undefined;
    while (true) {
      const actors = await getDb().select().from(federatedActors).where(cursor ? gt(federatedActors.id, cursor) : undefined).orderBy(asc(federatedActors.id)).limit(100);
      if (!actors.length) break;
      // Oxy re-evaluates current proof, expiry and redirects in this uncached
      // batch lookup. Existing sources need projection, not another remote fetch.
      // A failed authority read aborts the batch before any projection writes.
      const known = await lookupOxyIdentities(actors.map(actor => actor.uri));
      try {
        for (const actor of actors) {
          report.actorsExamined++;
          try {
            const lookup = known.find(row => row.identifier === actor.uri);
            const reference = lookup?.externalIdentities.find(row => row.actorUri === actor.uri);
            const registered = lookup?.userId && reference ? { ...reference, userId: lookup.userId } : undefined;
            const identity = registered ?? (dryRun ? undefined
              : (await resolveOxyIdentity({ actorUri: actor.uri, transportAcct: actor.acct, protocol: actor.protocol })).externalIdentity);
            if (!identity) { refuse('oxy_identity_not_resolved'); continue; }
            const result = await reconcileActorIdentityProjection({ actorUri: actor.uri, oxyUserId: identity.userId, networkAcct: identity.canonicalAcct, dryRun, cacheInvalidation: cacheBatch });
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
      } finally { await cacheBatch.flushUsers(); }
      cursor = actors[actors.length - 1].id;
      actorBatchesCompleted++;
      logger.info(`[${SCRIPT_NAME}] progress`, {
        dryRun, phase: 'actors', batchesCompleted: actorBatchesCompleted,
        actorsExamined: report.actorsExamined, actorsChanged: report.actorsChanged,
        postsChanged: report.postsChanged, authorshipConflicts: report.authorshipConflicts,
      });
    }
    // Only potential Meta candidates plus ALL existing members/collapsed rows:
    // withdrawn proof and orphaned/non-Meta clusters must still be re-evaluated.
    // This pass is bounded and independent of how many posts any one actor owns.
    let postBatchesCompleted = 0;
    let postCursor: string | undefined;
    while (true) {
      const rows = await getDb().select({ id: posts.id }).from(posts)
        .leftJoin(federatedActors, eq(federatedActors.uri, posts.federationActorUri))
        .where(and(crosspostReconciliationPostSql(), postCursor ? gt(posts.id, postCursor) : undefined))
        .orderBy(asc(posts.id)).limit(100);
      if (!rows.length) break;
      for (const post of rows) {
        report.postsExamined++;
        if (dryRun) continue;
        await reevaluateClusterForPost(post.id, { failOnError: true });
        const decision = await detectCrosspostEquivalence({ postId: post.id }, { failOnError: true });
        if (decision.outcome === 'clustered') report.postClustersCreated++;
        else if (decision.outcome === 'refused') refuse(decision.reason);
      }
      postCursor = rows[rows.length - 1].id;
      postBatchesCompleted++;
      logger.info(`[${SCRIPT_NAME}] progress`, {
        dryRun, phase: 'posts', batchesCompleted: postBatchesCompleted,
        postsExamined: report.postsExamined, postClustersCreated: report.postClustersCreated,
      });
    }
  } finally { await cacheBatch.finish(); }
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
