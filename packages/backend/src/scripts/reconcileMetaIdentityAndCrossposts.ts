/**
 * One-shot reconciliation for everything #990 introduces, over data that was
 * already stored before it landed.
 *
 * THREE INDEPENDENT PASSES, ONE REPORT. Each answers a question the live paths
 * only answer for rows arriving from now on:
 *
 *  1. **Instagram bridge identity.** `kilogram.makeup` actors still held under
 *     the bridge acct rather than re-labelled to `@handle@instagram.com`. The
 *     ingest gets this right today; a row cached before the policy entry, or one
 *     whose refresh has not come round, does not. Re-labelling is NOT done here:
 *     the derivation is per-actor and reads the live actor document, so the
 *     repair is to schedule a refresh — this pass FINDS and REPORTS them, which
 *     is what tells an operator whether the refresh loop is keeping up.
 *  2. **Cross-network person equivalence.** Instagram and Threads identities we
 *     can now prove are one Meta person. `reconcileCrossNetworkIdentity` decides,
 *     from the same claims and the same evaluator the live path uses, so the
 *     report cannot promise something the live path would refuse.
 *  3. **Historical cross-posts.** Instagram/Threads pairs already in `posts`
 *     that today's evidence would cluster.
 *
 * NOTHING HERE LOWERS A BAR. Every decision is delegated to the live modules;
 * this script's own logic is the SCAN and the counters. A one-shot with its own
 * looser copy of the rule is how a reconciliation ends up creating exactly the
 * merges the live path exists to refuse.
 *
 * IT NEVER HARD-DELETES AN OXY USER. Two identities that each minted their own
 * user before the evidence appeared are REPORTED, not merged: follows, blocks,
 * moderation records and post authorship already reference both, and re-pointing
 * one of them would strand every one of those. That decision needs an alias or
 * redirect strategy on the Oxy side and a human; this says which pairs are
 * waiting for it.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`; only `DRY_RUN=false` writes.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Batched, so no statement locks a large fraction of `posts`.
 *  4. Idempotent: an already-linked pair and an already-clustered post are both
 *     recognised and counted as such rather than re-written.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=reconcileMetaIdentityAndCrossposts \
 *     bun packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js
 */

import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { postEquivalenceMembers, posts } from '../db/schema/posts';
import { countEquivalence } from '../db/posts/postEquivalenceRepository';
import {
  listAttestedIdentityClaims,
  listIdentityLinks,
} from '../db/federation/identityEquivalenceRepository';
import {
  CROSS_NETWORK_IDENTITY_POLICY,
  participatesInCrossNetworkIdentity,
  reconcileCrossNetworkIdentity,
} from '../connectors/identityEquivalence';
import { FEDERATION_BRIDGE_POLICY } from '../connectors/activitypub/federationBridgePolicy';
import {
  classifyStoredPair,
  detectCrosspostEquivalence,
  findCrosspostSiblings,
} from '../services/PostEquivalenceService';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'reconcileMetaIdentityAndCrossposts';

/** Rows read per batch. */
const BATCH_SIZE = 500;

/** The counters #990 asks for, by name. */
export interface ReconciliationReport {
  instagramActorsExamined: number;
  instagramBridgeActorsRelabelled: number;
  instagramBridgeActorsStillUnderBridgeIdentity: number;
  crossNetworkIdentityClaimsFound: number;
  /** First-party attestations on file — see `recordAttestedIdentityLink`. */
  firstPartyAttestationsOnFile: number;
  identityPairsLinked: number;
  identityPairsRefusedOrAmbiguous: number;
  postCrosspostCandidates: number;
  postClustersCreated: number;
  postCandidatesRefusedForWeakEvidence: number;
}

/** Every bridge host whose actors carry an identity on a cross-network-paired network. */
function bridgeHostsForPairedNetworks(): string[] {
  return FEDERATION_BRIDGE_POLICY
    .filter((entry) => entry.relabel === 'enabled')
    .filter((entry) => participatesInCrossNetworkIdentity(entry.network.domain))
    .map((entry) => entry.host);
}

/**
 * Pass 1 — how many bridged Instagram actors carry the network identity and how
 * many are still under the bridge acct.
 *
 * REPORT-ONLY in both modes, deliberately. Deriving `@zuck@instagram.com`
 * requires the live actor document's `Official` field, and inventing one from
 * the stored acct would be exactly the "derive it from the username" shortcut
 * the bridge policy refuses. The repair is the ordinary refresh; what an
 * operator needs from a reconciliation is whether that refresh is keeping up,
 * and that is a count.
 */
async function reconcileBridgedInstagramActors(report: ReconciliationReport): Promise<void> {
  const hosts = bridgeHostsForPairedNetworks();
  if (hosts.length === 0) return;

  for (const host of hosts) {
    // eslint-disable-next-line no-await-in-loop
    const [relabelled] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(federatedActors)
      .where(and(eq(federatedActors.domain, host), isNotNull(federatedActors.networkAcct)));
    // eslint-disable-next-line no-await-in-loop
    const [stale] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(federatedActors)
      .where(and(eq(federatedActors.domain, host), isNull(federatedActors.networkAcct)));

    report.instagramBridgeActorsRelabelled += relabelled?.count ?? 0;
    report.instagramBridgeActorsStillUnderBridgeIdentity += stale?.count ?? 0;
    report.instagramActorsExamined += (relabelled?.count ?? 0) + (stale?.count ?? 0);

    logger.info(`[${SCRIPT_NAME}] bridge identity`, {
      host,
      relabelled: relabelled?.count ?? 0,
      stillUnderBridgeIdentity: stale?.count ?? 0,
    });
  }
}

/**
 * Pass 2 — re-run the cross-network identity decision over every actor whose
 * identity is on a paired network.
 *
 * A DRY RUN SKIPS THIS ENTIRELY rather than simulating it, and that is worth
 * stating: `reconcileCrossNetworkIdentity` WRITES — it records the actor's
 * current claims, which is exactly what makes the counterpart's later pass able
 * to see them. There is no read-only form of it that would report the same
 * numbers, because the numbers depend on claims this pass is what records. So a
 * dry run reports the links that already exist and says how many actors a live
 * run would examine, which is the honest answer.
 */
async function reconcileIdentities(report: ReconciliationReport, dryRun: boolean): Promise<void> {
  const pairedDomains = new Set(
    CROSS_NETWORK_IDENTITY_POLICY.flatMap((entry) => [...entry.networks]),
  );

  let cursor = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await getDb()
      .select({
        uri: federatedActors.uri,
        acct: federatedActors.acct,
        domain: federatedActors.domain,
        networkAcct: federatedActors.networkAcct,
        protocol: federatedActors.protocol,
      })
      .from(federatedActors)
      .where(cursor ? gt(federatedActors.uri, cursor) : undefined)
      .orderBy(asc(federatedActors.uri))
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].uri;

    for (const row of batch) {
      const identity = row.networkAcct ?? row.acct;
      const at = identity.lastIndexOf('@');
      const domain = at > 0 ? identity.slice(at + 1).toLowerCase() : '';
      if (!pairedDomains.has(domain)) continue;

      report.crossNetworkIdentityClaimsFound += 1;
      if (dryRun) continue;

      // eslint-disable-next-line no-await-in-loop
      const outcome = await reconcileCrossNetworkIdentity({
        network: row.protocol === 'atproto' ? 'atproto' : 'activitypub',
        externalId: row.uri,
        handle: row.acct,
        federatedUsername: identity,
        instanceDomain: domain,
      });
      if (outcome.adoptOxyUserId) report.identityPairsLinked += 1;
    }
  }

  // Counted from the LINK TABLE rather than from this run's own decisions, so
  // the report describes the state of the world and not the state of the loop —
  // an already-linked pair contributes on every run, which is what makes the
  // number comparable between runs.
  // Filed in both directions, so the pair count is half the row count. Reported
  // because an attestation is the one evidence kind no actor publishes — it is
  // invisible in the claim scan above, and an operator needs to see what is on
  // file rather than infer it from the links it produced.
  report.firstPartyAttestationsOnFile = (await listAttestedIdentityClaims()).length / 2;

  const linked = await listIdentityLinks('linked');
  const pending = await listIdentityLinks('pending_reconciliation');
  report.identityPairsLinked = Math.max(report.identityPairsLinked, linked.length);
  report.identityPairsRefusedOrAmbiguous = pending.length;

  for (const link of pending) {
    logger.warn(`[${SCRIPT_NAME}] provable pair holding two Oxy users; needs a human`, {
      identityA: link.identityA,
      identityB: link.identityB,
      reason: link.reason,
    });
  }
}

/**
 * Pass 3 — cluster historical cross-posts.
 *
 * Scans only posts that are NOT already in a cluster and whose author has at
 * least one sibling worth comparing, and hands every decision to
 * `detectCrosspostEquivalence` (live) or `classifyStoredPair` (dry run) so the
 * report and the live path cannot disagree about what would be clustered.
 */
async function reconcileCrossposts(report: ReconciliationReport, dryRun: boolean): Promise<void> {
  let cursor = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .leftJoin(postEquivalenceMembers, eq(postEquivalenceMembers.postId, posts.id))
      .where(and(
        cursor ? gt(posts.id, cursor) : undefined,
        eq(posts.status, 'published'),
        isNotNull(posts.federationActorUri),
        isNull(postEquivalenceMembers.id),
      ))
      .orderBy(asc(posts.id))
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const row of batch) {
      // eslint-disable-next-line no-await-in-loop
      const siblings = await findCrosspostSiblings(row.id);
      if (siblings.length === 0) continue;
      report.postCrosspostCandidates += 1;

      if (dryRun) {
        let matched = false;
        for (const sibling of siblings) {
          // eslint-disable-next-line no-await-in-loop
          if (await classifyStoredPair(row.id, sibling)) {
            matched = true;
            break;
          }
        }
        if (matched) report.postClustersCreated += 1;
        else report.postCandidatesRefusedForWeakEvidence += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const decision = await detectCrosspostEquivalence({ postId: row.id });
      if (decision.outcome === 'clustered') report.postClustersCreated += 1;
      else if (decision.outcome === 'refused') report.postCandidatesRefusedForWeakEvidence += 1;
    }
  }
}

/** The reconciliation itself. The CALLER owns the connection lifecycle. */
export async function reconcileMetaIdentityAndCrossposts(
  opts: { dryRun?: boolean } = {},
): Promise<ReconciliationReport> {
  const dryRun = opts.dryRun ?? true;
  const startedAt = Date.now();
  const report: ReconciliationReport = {
    instagramActorsExamined: 0,
    instagramBridgeActorsRelabelled: 0,
    instagramBridgeActorsStillUnderBridgeIdentity: 0,
    crossNetworkIdentityClaimsFound: 0,
    firstPartyAttestationsOnFile: 0,
    identityPairsLinked: 0,
    identityPairsRefusedOrAmbiguous: 0,
    postCrosspostCandidates: 0,
    postClustersCreated: 0,
    postCandidatesRefusedForWeakEvidence: 0,
  };

  await reconcileBridgedInstagramActors(report);
  await reconcileIdentities(report, dryRun);
  await reconcileCrossposts(report, dryRun);

  const equivalence = await countEquivalence();
  logger.info(`[${SCRIPT_NAME}] complete`, {
    dryRun,
    ...report,
    clustersInDatabase: equivalence.clusters,
    collapsedPostsInDatabase: equivalence.collapsedPosts,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
  });
  return report;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await reconcileMetaIdentityAndCrossposts({ dryRun });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
