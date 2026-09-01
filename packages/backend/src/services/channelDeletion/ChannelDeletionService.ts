/**
 * Executes `CHANNEL_CASCADE` — the destruction of one channel account's
 * content, and of every row in Mention's own database that points at it.
 *
 * WHAT THIS IS NOT
 *
 * It does not delete the Oxy account, its membership rows, its follow edges or
 * its uploaded bytes; those live on the far side of the Oxy boundary and are
 * enumerated in `OWNED_BY_OXY` rather than silently omitted.
 *
 * WHERE THE PARTS LIVE
 *
 * This file is the entry point and the ORDER — `deleteChannelContent` and the
 * keyset loop under it are the whole design, and each phase's comment says what
 * a crash inside it leaves behind. Each step of that order has its own owner:
 * `channelDeletionTargets.ts` (what the run is pointed at, and the boost closure
 * a batch captures), `channelCascadeBinding.ts` + `channelStepBindings.ts` (how
 * a manifest step becomes a statement), `channelCascadeQueries.ts` (count-or-
 * delete), `channelCascadeRun.ts` (the schedule and the four disjoint accounts),
 * `channelDeletionFederation.ts` (Tombstones and the actor Delete) and
 * `channelCounterRepair.ts` (counters on posts that survive).
 *
 * IT REFUSES ANYTHING THAT IS NOT A CHANNEL
 *
 * The account `kind` is resolved here, at the top of both entry points, before a
 * single post is read — see {@link NotAChannelAccountError}. It used to be the
 * caller's job, on the reasoning that no route calls this yet; the absence of a
 * route is the absence of an accident, not a defence, and pointing this at a
 * personal account destroys a person's writing irreversibly. An unresolvable kind
 * is a refusal too: `resolveAccountKind` is fail-soft to `null` by design and
 * leaves the decision to its caller, and the two directions here are not
 * comparable — refusing delays an administrative action, allowing may destroy the
 * wrong account's posts.
 *
 * ## THE CASCADE IS SMALLER THAN THE MANIFEST, AND THAT IS THE POINT
 *
 * Eighteen manifest entries are performed by POSTGRES: thirteen child tables of
 * `posts` are `ON DELETE CASCADE`, `posts.boost_of` is a SELF-cascade, and
 * `quote_of` / `parent_post_id` / `thread_id` / `lane_id` are
 * `ON DELETE SET NULL`. **There is no leg here for any of them, deliberately.** A
 * leg would re-implement work the `DELETE` statement has already done, and it
 * would be PERMANENTLY UNTESTABLE: every residue check runs after the delete,
 * when the rows are gone either way, so nothing could ever tell "my leg ran" from
 * "the FK ran". A leg nobody can prove ran is indistinguishable from a leg that
 * never worked. Do not "complete" this module by adding them back — the same
 * boundary `services/PostDeletionCascade.ts` states for the live delete route.
 *
 * What is left is everything a foreign key cannot express, and that is almost
 * entirely **rows keyed on an Oxy ACCOUNT id**: Oxy owns identity, so every
 * `oxy_user_id` / `user_id` / `actor_id` / `owner_oxy_user_id` is a foreign
 * service's primary key in a plain `text()` column with no constraint. Postgres
 * cascades none of it, so every channel-account-scoped step is a real leg.
 *
 * ## `posts.boost_of` CASCADES, SO THE CAPTURE COMES FIRST
 *
 * Deleting a channel post deletes every boost of it, transitively, inside the
 * same statement — which is main's whole `collectBoostClosure` / `MAX_BOOST_CLOSURE`
 * / "boost rows last" machinery performed by one constraint. But it means the
 * boost rows and their `boost_of` links are gone before any later step could run,
 * and those boosts carry POLYMORPHIC references of their own (a notification, a
 * content label, a postgate, a feed interaction) with nothing left to find them
 * by. So each batch captures its boost closure BEFORE the delete, while the links
 * are still live, and hands the whole set to the delegate.
 *
 * ## THE MANIFEST IS THE PROGRAM
 *
 * Every write this cascade makes is driven by an entry in `CHANNEL_CASCADE`
 * (`channelStepBindings.ts` is where each one's Postgres shape is written down).
 * Nothing is
 * deleted that the manifest does not name, and every manifest entry is accounted
 * for in the result — under `steps` with a count when this service performs the
 * write, under `delegated` when `PostDeletionCascade` owns the disposition, under
 * `performedByDatabase` when a constraint does it, and under `retained` when the
 * row is deliberately kept. `__tests__/services/channelDeletionService.test.ts`
 * asserts that the four key sets are disjoint and that their union is EXACTLY the
 * manifest's, so a step that stops executing disappears from all four and fails
 * the build rather than silently leaving rows behind. The three non-executing
 * accounts carry no count on purpose: a fabricated `0` is indistinguishable from
 * a step that never ran, which is the failure this binding exists to catch. Do
 * not pre-seed `steps` from the manifest either — that satisfies the assertion
 * while executing nothing.
 *
 * ## BATCHED, AND THEREFORE NEVER REFUSED FOR SIZE
 *
 * A channel is a publication and its archive is unbounded, so the posts are taken
 * in keyset batches rather than materialised whole. The Mongo shape refused past
 * a boost-closure cap; that refusal was correct there and would be a cascade
 * nobody could run here, because the bound would have to cover a whole archive
 * rather than one post's boosts. The keyset advances on `posts.id`, so a re-run
 * after a partial failure simply re-walks from the start over what survived.
 *
 * ## RETRY CONTRACT
 *
 * Per-step failures are collected, every remaining step still runs, and the call
 * THROWS at the end — the `sharingCleanup.service.ts` throw-on-partial shape, so
 * a BullMQ worker or an operator retries against whatever survived. Every step is
 * idempotent, so a re-run converges: a second pass over an already-deleted channel
 * returns all-zero counts and does not throw.
 */
import type { AccountKind } from '@oxyhq/contracts';
import { getDb } from '../../db/postgres';
import {
  assertPostsSafeToDelete,
  collectPostCascadeResidue,
  type PostReferenceProbeName,
} from '../../scripts/lib/adminDeletionPreflight';
import {
  CASCADED_POST_REFERENCES,
  POST_REFERENCES_KEPT_BY_POLICY,
  POST_REFERENCES_REMOVED_BY_DATABASE,
  cascadePostReferences,
} from '../PostDeletionCascade';
import { resolveAccountKind } from '../publishAsAccount';
import { logger } from '../../utils/logger';
import { LOG_PREFIX } from './channelCascadeLog';
import { buildSchedule, CascadeRun, runPhase, type Schedule } from './channelCascadeRun';
import { stepKey } from './channelCascadeBinding';
import {
  broadcastActorDelete,
  broadcastBatchTombstones,
  resolveChannelUsername,
} from './channelDeletionFederation';
import { readLikedPostIds, repairSurvivingCounters } from './channelCounterRepair';
import {
  deletionTargetsOf,
  readPostBatch,
  resolveDeletionTargets,
  type DeletionTargets,
  type PostBatch,
} from './channelDeletionTargets';

/**
 * What this cascade tells the preflight about the post references it does not
 * have to prove absent, in the three shapes the gate distinguishes.
 *
 * All three are DERIVED from `POST_REFERENCE_DISPOSITION` rather than restated,
 * because the disposition of a post reference is that table's decision and a copy
 * here would be free to disagree with the code that actually runs. They are typed
 * `PostReferenceProbeName[]`, so a probe renamed or added upstream breaks this
 * build instead of being silently acknowledged.
 *
 *  - {@link CASCADED_POST_REFERENCES} is a CLAIM that the delegate's legs removed
 *    the rows.
 *  - {@link POST_REFERENCES_REMOVED_BY_DATABASE} is the same claim made about the
 *    `ON DELETE CASCADE` constraints, under a name that says who did it. Folding
 *    it into the list above would say this module deleted rows it never touched.
 *  - {@link POST_REFERENCES_KEPT_BY_POLICY} is a decision that they STAY — the
 *    retained `reports.reported_id(post)` and the delivery queue whose live
 *    backlog is cancelled while its completed rows remain as a log. Declaring it
 *    as a claim instead would make the residue check report every one of them as a
 *    cascade leg that had stopped working.
 */
const REMOVED_BEFORE_THE_POSTS: readonly PostReferenceProbeName[] = CASCADED_POST_REFERENCES;
const REMOVED_BY_DATABASE: readonly PostReferenceProbeName[] = POST_REFERENCES_REMOVED_BY_DATABASE;
const KEPT_BY_POLICY: readonly PostReferenceProbeName[] = POST_REFERENCES_KEPT_BY_POLICY;

/**
 * What the residue check re-runs after a batch is gone.
 *
 * BOTH claims, not just the delegate's. `PostDeletionCascade` deliberately omits
 * the database-removed half on the live delete route, because re-running six
 * probes on every user-facing delete to verify something the schema guarantees
 * structurally is a cost nobody is buying anything with. An administrative
 * one-shot is the other case: the probes are cheap here, and they check the END
 * STATE — "no row references these posts" — rather than crediting a leg with
 * having run. That distinction is what keeps it from being the untestable-leg
 * mistake in a different costume.
 */
const RESIDUE_CLAIM: readonly PostReferenceProbeName[] = [
  ...REMOVED_BEFORE_THE_POSTS,
  ...REMOVED_BY_DATABASE,
];

/**
 * The account this was pointed at is not a channel, so nothing was read and
 * nothing was written.
 *
 * The message distinguishes the two causes ON PURPOSE, because the operator
 * response is not the same one: "resolved as personal" means the id is wrong and
 * the run must never be repeated as-is, while "could not be resolved" means Oxy
 * could not answer and the same command is worth retrying once identity is back.
 * A single "not a channel" message would make the second look like the first, and
 * the natural reaction to the first — go and find the right id — is exactly the
 * wrong reaction to the second.
 */
export class NotAChannelAccountError extends Error {
  /** The kind Oxy answered with, or `null` when the read produced no answer. */
  readonly resolvedKind: AccountKind | null;

  constructor(oxyUserId: string, resolvedKind: AccountKind | null) {
    super(
      resolvedKind === null
        ? `${LOG_PREFIX} refused: the Oxy account kind of ${oxyUserId} could not be resolved, and ` +
            'deleting an account whose kind is unknown is not a risk this takes'
        : `${LOG_PREFIX} refused: ${oxyUserId} resolved as ${resolvedKind}, not a channel`,
    );
    this.name = 'NotAChannelAccountError';
    this.resolvedKind = resolvedKind;
  }
}

/**
 * Refuse anything that is not a channel, before a single row is read.
 *
 * `resolveAccountKind` is fail-soft to `null` by design — the reply gate needs an
 * identity outage not to refuse every reply on the site — so the DECISION is the
 * caller's, and here it is no. The two directions are not comparable: refusing
 * delays an administrative action that can be re-run, while allowing destroys a
 * person's posts irreversibly if the id turns out to name a personal account.
 *
 * The `catch` is deliberate belt-and-braces rather than dead code: the fail-soft
 * contract lives in another module and could be tightened there without anybody
 * looking at this call site, and a rejection that propagated would abort the run
 * with an error that says nothing about why.
 */
async function assertChannelAccount(oxyUserId: string): Promise<void> {
  let kind: AccountKind | null;
  try {
    kind = await resolveAccountKind(oxyUserId);
  } catch (error) {
    logger.error(`${LOG_PREFIX} could not resolve the account kind`, error);
    throw new NotAChannelAccountError(oxyUserId, null);
  }
  if (kind !== 'channel') {
    logger.warn(`${LOG_PREFIX} refused a deletion for a non-channel account`, {
      oxyUserId,
      resolvedKind: kind,
    });
    throw new NotAChannelAccountError(oxyUserId, kind);
  }
}

export interface ChannelDeletionPreview {
  channelOxyUserId: string;
  /** The channel's own posts. */
  posts: number;
  /** Other people's boosts of them, which the database destroys alongside. */
  boostsByOthers: number;
  /** Other people's replies into the set. A channel cannot be replied to, so 0. */
  replies: number;
  /** Other people's quotes of a doomed post: kept, pointer cleared. */
  quotesByOthersKept: number;
  /** Remote inboxes the `Delete(actor)` will reach. */
  federatedFollowers: number;
}

function buildPreview(targets: DeletionTargets): ChannelDeletionPreview {
  return {
    channelOxyUserId: targets.channelOxyUserId,
    posts: targets.posts,
    boostsByOthers: targets.boostsByOthers,
    replies: targets.repliesByOthers,
    quotesByOthersKept: targets.quotesByOthersKept,
    federatedFollowers: targets.federatedFollowers,
  };
}

/**
 * What deleting this channel would cost, without touching anything.
 *
 * Gated on the account kind exactly like the deletion itself: a preview of "every
 * post this person has ever written" is not a harmless read to hand back for an
 * account nobody established is a channel.
 *
 * `replies` should always be 0 — the reply gate refuses a `channel` author at
 * five sites — and a non-zero value is a finding, not a number to accept.
 */
export async function previewChannelDeletion(
  channelOxyUserId: string,
): Promise<ChannelDeletionPreview> {
  await assertChannelAccount(channelOxyUserId);
  return buildPreview(await resolveDeletionTargets(channelOxyUserId));
}

export interface ChannelDeletionResult {
  /**
   * Affected-row counts for the steps THIS service executed, keyed EXACTLY
   * `${step.table}.${step.column}`.
   *
   * A key whose column is classified under two scopes appears here when EITHER
   * scope runs locally, and the count is that local work only — the other scope's
   * disposition is on its manifest entry.
   */
  steps: Record<string, number>;
  /**
   * Manifest keys whose disposition belongs to
   * `PostDeletionCascade.cascadePostReferences`. Listed without a count on
   * purpose: the delegate throws on a failed leg rather than reporting
   * per-reference totals, and inventing a `0` here would be indistinguishable
   * from a step that never ran.
   */
  delegated: string[];
  /**
   * Manifest keys an `ON DELETE` constraint performs. Listed without a count for
   * the same reason, and with a stronger one besides: nothing in this process
   * ever sees those rows, so any number here would be fabricated.
   */
  performedByDatabase: string[];
  /** Manifest keys deliberately KEPT — see each entry's `why` for the reason. */
  retained: string[];
  preview: ChannelDeletionPreview;
  dryRun: boolean;
}

/**
 * Destroy one channel's content and every Mention row pointing at it.
 *
 * The order below is the whole design; each phase says what a crash inside it
 * leaves behind, and none of those states is unrecoverable by a re-run.
 */
export async function deleteChannelContent(
  channelOxyUserId: string,
  options: { dryRun: boolean },
): Promise<ChannelDeletionResult> {
  const { dryRun } = options;

  // 0. Refuse anything that is not a channel, before any read of the post set and
  //    long before any write or federation call. Pointed at a personal account
  //    this destroys a person's writing, and no route existing today is the
  //    absence of an accident rather than a defence against one.
  await assertChannelAccount(channelOxyUserId);

  const run = new CascadeRun();
  const schedule = buildSchedule(run);

  // 1. Read the preview counts. Read-only, so a crash here has changed nothing.
  const targets = await resolveDeletionTargets(channelOxyUserId);
  const preview = buildPreview(targets);
  logger.info(`${LOG_PREFIX} resolved deletion targets`, {
    dryRun,
    posts: preview.posts,
    boostsByOthers: preview.boostsByOthers,
    replies: preview.replies,
    quotesByOthersKept: preview.quotesByOthersKept,
    federatedFollowers: preview.federatedFollowers,
  });

  // 2. Drain the channel's undelivered outbound activities. The manifest requires
  //    this BEFORE the actor Delete, or a queued Create races it and republishes a
  //    post on the receiving instance. A crash here leaves some queued activities
  //    that a re-run drains; nothing has been told the channel is gone yet.
  await runPhase('federation-drain', schedule, targets, dryRun, run);

  // 3. The channel's posts, in keyset batches. Everything about a batch — the
  //    preflight, the Tombstones, the delegate, the local post-scoped legs and the
  //    `DELETE` — happens while its captured ids are still meaningful.
  //
  //    A crash mid-loop leaves the channel with fewer posts and a fediverse that
  //    has been told about the ones already gone. A re-run walks from the start
  //    over what survived.
  const username =
    !dryRun && targets.federatedFollowers > 0
      ? await resolveChannelUsername(channelOxyUserId)
      : null;
  const boostedOriginals = await destroyChannelPosts(
    channelOxyUserId,
    schedule,
    dryRun,
    username,
    run,
  );

  // 4. Tell the fediverse the actor itself is gone. Nothing delivery reads has
  //    been deleted yet — the `federated_follows` rows it resolves inboxes from go
  //    in the account phase below. A crash here leaves an actor remote servers may
  //    already have dropped while its local account rows survive; a re-run re-sends
  //    (Delete is idempotent remotely) and completes the cascade.
  if (username) {
    await broadcastActorDelete(channelOxyUserId, username);
  }

  // 5. Which posts the channel liked, read while its `likes` rows still exist —
  //    the account phase below deletes them, and a repair that looked afterwards
  //    would find nothing and leave every one of those counters an increment too
  //    high with no error anywhere.
  const likedPostIds = await readLikedPostIds(channelOxyUserId);

  // 6. Lane rows, then the account-keyed rows. Within the lane phase the mutes are
  //    swept by publisher and viewer BEFORE the lanes they hang off, so a mute is
  //    never left to `lane_mutes.lane_id`'s cascade alone — that constraint covers
  //    the lane key, and the two account-keyed columns carry no constraint at all.
  await runPhase('lanes', schedule, targets, dryRun, run);
  await runPhase('account', schedule, targets, dryRun, run);

  // 7. Counters on posts that SURVIVE but lost an engagement record. Deliberately
  //    not part of `steps`: no manifest entry describes a counter, and inventing a
  //    key would break the set equality that binds this file to the manifest.
  const counters = await repairSurvivingCounters(boostedOriginals, likedPostIds, dryRun);
  logger.info(`${LOG_PREFIX} repaired counters on surviving posts`, {
    dryRun,
    boostCounters: counters.boostCounters,
    likeCounters: counters.likeCounters,
  });

  if (run.failures.length > 0) {
    throw new Error(
      `${LOG_PREFIX} ${run.failures.length} cascade step(s) failed for ${channelOxyUserId} ` +
        `(${run.failures.join(', ')}) — the run will be retried against whatever survived`,
    );
  }

  const { delegated, performedByDatabase, retained } = run.classify();
  return { steps: run.steps, delegated, performedByDatabase, retained, preview, dryRun };
}

/**
 * Walk the channel's posts in keyset batches, destroying each one completely
 * before reading the next.
 *
 * Returns the ids of SURVIVING posts that lost a boost to this run — a channel
 * post that boosted somebody else's post, collected per batch because that is the
 * only moment its `boost_of` is still readable.
 */
async function destroyChannelPosts(
  channelOxyUserId: string,
  schedule: Schedule,
  dryRun: boolean,
  username: string | null,
  run: CascadeRun,
): Promise<string[]> {
  const boostedOriginals: string[] = [];
  let after: string | null = null;

  // Open every batch-scoped step's account at zero BEFORE the loop, so a channel
  // with no posts still reports them rather than leaving five manifest keys
  // unaccounted for.
  //
  // Derived from the SCHEDULE, never from the manifest, and that is the whole
  // difference: a step whose binding is removed drops out of `schedule.inBatch`,
  // is not seeded, and fails the union assertion — which is exactly what
  // pre-seeding from the manifest would have hidden. What is claimed here is only
  // "this step was reached", which is true the moment the loop is entered.
  for (const { step } of schedule.inBatch) run.record(stepKey(step), 0);

  for (;;) {
    const batch: PostBatch | null = await readPostBatch(channelOxyUserId, after);
    if (!batch) break;
    after = batch.lastId;

    const removedIds = new Set(batch.rows.map((row) => row.id));
    for (const post of batch.channelPosts) {
      if (post.boostOf && !removedIds.has(post.boostOf)) boostedOriginals.push(post.boostOf);
    }

    // Prove the deletion cannot strand a reference nobody cleans. Read-only, and
    // deliberately BEFORE the Tombstones rather than after: a refusal here is
    // permanent until an operator acts, and broadcasting first would leave remote
    // servers holding a Tombstone for posts that are still live locally, on every
    // retry. It runs in a dry run too, so a blocker surfaces before a live run.
    await assertPostsSafeToDelete(
      `channelDeletion:${channelOxyUserId}`,
      deletionTargetsOf(batch.rows),
      {
        removedByCascade: [...REMOVED_BEFORE_THE_POSTS, ...REMOVED_BY_DATABASE],
        // Stated separately from the claim above because it is the opposite kind
        // of statement: these rows are kept on purpose, so the residue check must
        // not demand their absence.
        keptByPolicy: KEPT_BY_POLICY,
        // The graph probe would otherwise refuse the run for the quotes and
        // replies `ON DELETE SET NULL` clears — a strictly stronger disposition
        // than the dangling pointer the allowance describes. `boost_of` stays
        // covered, and the closure captured above is what keeps it satisfied.
        allowDanglingReplyReferences: true,
      },
    );

    if (username) {
      await broadcastBatchTombstones(batch, channelOxyUserId, username);
    }

    // The delegate, then the local post-scoped legs, then the `DELETE` — all in
    // ONE transaction. The delegate THROWS on a failed leg, and that is only
    // coherent inside a transaction: a leg that fails rolls the batch back, the
    // posts are NOT deleted, and a retry can still reach the rows it left. Outside
    // one, the same throw would report a partly-completed batch whose leftovers
    // nothing could find.
    try {
      if (dryRun) {
        for (const { step, binding } of schedule.inBatch) {
          run.record(stepKey(step), await binding.run(batch, true));
        }
      } else {
        await getDb().transaction(async (tx) => {
          await cascadePostReferences(batch.rows, tx);
          for (const { step, binding } of schedule.inBatch) {
            run.record(stepKey(step), await binding.run(batch, false));
          }
        });
      }
    } catch (error) {
      run.failDelegated(`batch@${batch.lastId}`);
      logger.error(`${LOG_PREFIX} a post batch failed and was rolled back`, {
        channelOxyUserId,
        lastId: batch.lastId,
        error,
      });
      continue;
    }

    // Verify what the batch CLAIMED to remove actually went, with nothing
    // acknowledged. OUTSIDE the transaction on purpose: inside it the probes would
    // read the transaction's own uncommitted deletes and pass by construction,
    // which is a check that cannot fail. Skipped in a dry run, where every claim is
    // trivially unmet because nothing was deleted.
    if (!dryRun) {
      const residue = await collectPostCascadeResidue(
        deletionTargetsOf(batch.rows),
        RESIDUE_CLAIM,
      );
      if (residue.length > 0) {
        logger.error(`${LOG_PREFIX} cascade claimed references it did not remove`, {
          channelOxyUserId,
          residue,
        });
      }
    }
  }

  return boostedOriginals;
}
