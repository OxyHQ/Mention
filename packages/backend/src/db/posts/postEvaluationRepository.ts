import { config } from '../../config';
import { withShadowReceiptDatabase, type ShadowReceiptDatabase } from './shadowReceiptDatabase';
import { isDeepStrictEqual } from 'node:util';
import { shadowReceiptAuthoritySchema, shadowUsageReconciliationSchema, sameReceiptAuthority,
  type ShadowReceiptAuthority, type ShadowReceiptReader } from '../../services/contentClassification/jevReceipt';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notExists, or } from 'drizzle-orm';
import { getDb, type Transaction } from '../postgres';
import { posts } from '../schema/posts';
import { postContentVariants } from '../schema/postContent';
import { postEvaluations, postEvaluationTopics } from '../schema/postEvaluations';
import { federatedActors, federatedFollows } from '../schema/federation';
import { postImports } from '../schema/imports';
import { userSettings } from '../schema/userProfile';
import { lockProfileVisibility } from '../userProfile/userSettingsRepository';
import { lockPostContent } from './postRepository';
import { logger } from '../../utils/logger';
import {
  shadowAbstention, shadowFingerprint, shadowSignalsSchema, validateShadowRelease,
  type ShadowRelease, type ShadowSignals, type ShadowSnapshot,
} from '../../services/contentClassification/jevShadow';

/**
 * Only posts written natively on Mention by an author with a public profile can
 * leave for an external classifier. A `public` row is not proof of a listed
 * post: ActivityPub maps `Public` in `cc` (unlisted) to public, Oxy Move imports
 * Mastodon unlisted posts as public, and remote actors' `discoverable` is
 * hardcoded true for atproto and Instagram. Until durable listed provenance
 * exists, a federated source (activity, actor, or a minted federated author
 * account) and any imported post are ineligible, followed or not.
 *
 * A private or followers-only profile overrides its posts' own `public` flag,
 * as in `canViewAuthorFeed` and the SEO sitemap's `publicSeoPost`: no settings
 * row is the default public profile, a missing owner fails closed. That check is
 * {@link publicProfileLocked}. Following is a quality signal, never a privacy
 * grant; security enforcement stays separate.
 */
const eligibleSource = (tx: Transaction) => and(
  isNull(posts.federationActivityId), isNull(posts.federationActorUri), isNotNull(posts.oxyUserId),
  notExists(tx.select({ id: federatedActors.id }).from(federatedActors)
    .where(eq(federatedActors.oxyUserId, posts.oxyUserId))),
  notExists(tx.select({ postId: postImports.postId }).from(postImports)
    .where(eq(postImports.postId, posts.id))),
);

/**
 * Hold the owner's profile visibility steady until commit, then read it. A
 * writer that committed first is seen by this fresh read; one that comes later
 * waits for this transaction. Taken after the post locks: writers take nothing
 * before it, so the order cannot invert.
 */
async function publicProfileLocked(tx: Transaction, owner: string): Promise<boolean> {
  await lockProfileVisibility(tx, owner, 'read');
  const [settings] = await tx.select({ visibility: userSettings.privacyProfileVisibility })
    .from(userSettings).where(eq(userSettings.oxyUserId, owner));
  return !settings || settings.visibility === 'public';
}

/** Lock order matches content writers: rendition advisory lock, then post row. */
async function lockSnapshot(tx: Transaction, postId: string): Promise<ShadowSnapshot | null> {
  await lockPostContent(tx, postId);
  const [post] = await tx.select({
    actorUri: posts.federationActorUri,
    owner: posts.oxyUserId,
    languages: posts.classificationLanguages,
  }).from(posts).where(and(
    eq(posts.id, postId), eq(posts.visibility, 'public'), eq(posts.status, 'published'),
    isNull(posts.boostOf), eligibleSource(tx),
  )).for('update');
  if (!post?.owner || !await publicProfileLocked(tx, post.owner)) return null;
  const renditions = await tx.select({
    id: postContentVariants.id, position: postContentVariants.position,
    tag: postContentVariants.tag, source: postContentVariants.source,
    body: postContentVariants.body, articleTitle: postContentVariants.articleTitle,
    articleBody: postContentVariants.articleBody, articleExcerpt: postContentVariants.articleExcerpt,
  }).from(postContentVariants).where(eq(postContentVariants.postId, postId))
    .orderBy(asc(postContentVariants.position)).for('share');
  return { postId, ...post, languages: post.languages ?? [], renditions };
}

export interface ShadowClaim {
  readonly id: string;
  readonly snapshot: ShadowSnapshot;
  readonly fingerprint: string;
}

/** A successful insert is the only authorization to infer. No lease takeover. */
export async function claimPostEvaluation(postId: string, release: ShadowRelease, receiptAuthority?: ShadowReceiptAuthority, requestDeadlineAt?: Date): Promise<ShadowClaim | null> {
  validateShadowRelease(release);
  const authority = receiptAuthority === undefined ? null : shadowReceiptAuthoritySchema.parse(receiptAuthority);
  if (requestDeadlineAt && (!authority || !Number.isFinite(requestDeadlineAt.getTime()))) {
    throw new Error('Original deadline requires valid recorded authority');
  }
  return getDb().transaction(async tx => {
    const snapshot = await lockSnapshot(tx, postId);
    if (!snapshot) return null;
    const fingerprint = shadowFingerprint(snapshot);
    const abstention = shadowAbstention(snapshot, release);
    const [claim] = await tx.insert(postEvaluations).values({
      postId, fingerprint, model: release.model, receiptAuthority: authority, requestDeadlineAt, policyRef: release.policyRef,
      policyVersion: release.policyVersion, evaluationVersion: release.evaluationVersion,
      state: abstention ? 'abstained' : 'claimed', abstention,
      finishedAt: abstention ? new Date() : null,
    }).onConflictDoNothing().returning({ id: postEvaluations.id });
    if (!claim || abstention) return null;
    return { id: claim.id, snapshot, fingerprint };
  });
}

/**
 * This only records evidence. A follow (including a future follow) can never be
 * rejected by this ledger. Replies/mentions/quotes/ancestors are not follow edges.
 * While only native posts are eligible every completed row records `unknown`;
 * the lookup returns once federated posts carry durable listed provenance.
 */
export async function originalActorFollowState(tx: Transaction, actorUri: string | null) {
  if (!actorUri) return 'unknown' as const; // Oxy owns the local graph.
  try {
    // Savepoint keeps a lookup failure from poisoning the final-write transaction.
    return await tx.transaction(async lookup => {
      const [edge] = await lookup.select({ id: federatedFollows.id }).from(federatedFollows).where(and(
        eq(federatedFollows.remoteActorUri, actorUri),
        eq(federatedFollows.direction, 'outbound'), eq(federatedFollows.status, 'accepted'),
      )).limit(1);
      return edge ? 'accepted' as const : 'not_followed' as const;
    });
  } catch (error) {
    logger.warn('[PostClassification] Shadow follow evidence unavailable', error);
    return 'unknown' as const;
  }
}

/** Compare and write while holding the content and visibility/deletion locks. */
export async function completePostEvaluation(claim: ShadowClaim, input: ShadowSignals): Promise<boolean> {
  const signals = shadowSignalsSchema.parse(input);
  if (JSON.stringify(signals.languages) !== JSON.stringify(claim.snapshot.languages)) {
    throw new Error('Shadow result languages differ from the claimed evidence');
  }
  return getDb().transaction(async tx => {
    const [identity] = await tx.select({ policyRef: postEvaluations.policyRef, policyVersion: postEvaluations.policyVersion })
      .from(postEvaluations).where(eq(postEvaluations.id, claim.id));
    if (!identity) return false; // Deleted claims cannot resurrect results.
    if (identity.policyRef !== signals.sdkReceipt.routingPolicy.routingPolicyId
      || identity.policyVersion !== signals.sdkReceipt.routingPolicy.policyVersion) {
      throw new Error('Shadow SDK policy receipt differs from the claim');
    }
    const current = await lockSnapshot(tx, claim.snapshot.postId);
    const same = current && shadowFingerprint(current) === claim.fingerprint;
    if (!same) {
      await tx.update(postEvaluations).set({ state: 'cancelled', finishedAt: new Date() })
        .where(and(eq(postEvaluations.id, claim.id), eq(postEvaluations.state, 'claimed')));
      return false;
    }
    // Re-read immediately before the final write; never use queue-time follows.
    const followState = await originalActorFollowState(tx, current.actorUri);
    const [written] = await tx.update(postEvaluations).set({
      state: 'completed', finishedAt: new Date(), followState,
      languages: signals.languages, spam: signals.spam, repetition: signals.repetition,
      feedValue: signals.feedValue, sdkReceipt: signals.sdkReceipt, languageEvidence: signals.languageEvidence,
    }).where(and(eq(postEvaluations.id, claim.id), eq(postEvaluations.state, 'claimed'),
      eq(postEvaluations.fingerprint, claim.fingerprint))).returning({ id: postEvaluations.id });
    if (!written) return false;
    if (signals.topics.length) {
      await tx.insert(postEvaluationTopics).values(signals.topics.map(topic => ({
        evaluationId: claim.id, topic: topic.topic, probability: topic.probability,
      })));
    }
    return true;
  });
}

/** Includes timeouts, invalid output and ambiguous final writes. NEVER re-infer. */
export async function markPostEvaluationUncertain(claim: ShadowClaim): Promise<void> {
  await getDb().update(postEvaluations).set({ state: 'cost_uncertain', finishedAt: new Date() })
    .where(and(eq(postEvaluations.id, claim.id), eq(postEvaluations.state, 'claimed')));
}

/**
 * Only for a claim whose id was never handed to an evaluator: nothing can have
 * been spent, so the revision may be claimed again later under a new id. Any
 * call that may have started is `cost_uncertain` instead, never released.
 */
export async function releaseUnsentPostEvaluation(claim: ShadowClaim): Promise<void> {
  await getDb().delete(postEvaluations)
    .where(and(eq(postEvaluations.id, claim.id), eq(postEvaluations.state, 'claimed')));
  logger.info('[PostClassification] Shadow claim released before any evaluator call', { evaluationId: claim.id });
}


/** A caller deadline does not wait indefinitely for a credential/transport promise. */
async function readUsageBounded(reader: ShadowReceiptReader, id: string, model: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return reader.readOriginal(id, model);
  let aborted: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
  });
  try {
    return await Promise.race([reader.readOriginal(id, model, signal), deadline]);
  } finally {
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}

function recoverableUsage(row: typeof postEvaluations.$inferSelect): boolean {
  return ['cost_uncertain', 'cancelled'].includes(row.state)
    || (row.state === 'claimed' && row.requestDeadlineAt !== null && row.requestDeadlineAt.getTime() <= Date.now());
}

/** Recover only accounting evidence; never run an evaluator or revive an answer. */
export async function reconcilePostEvaluationUsage(id: string, reader: ShadowReceiptReader, signal?: AbortSignal, context?: ShadowReceiptDatabase): Promise<boolean> {
  if (!context) return withShadowReceiptDatabase(Date.now() + config.inference.timeoutMs, signal,
    scoped => reconcilePostEvaluationUsage(id, reader, scoped.signal, scoped));
  context.check();
  const [original] = await context.db.select().from(postEvaluations).where(eq(postEvaluations.id, id));
  context.check();
  if (!original || !recoverableUsage(original) || !original.receiptAuthority
    || !sameReceiptAuthority(original.receiptAuthority, reader.authority)) return false;
  if (original.usageReconciliation) return true;
  const originalAuthority = original.receiptAuthority;
  const evidence = shadowUsageReconciliationSchema.parse(await readUsageBounded(reader, id, original.model, signal));
  if (!sameReceiptAuthority(original.receiptAuthority, evidence.authority) || evidence.model !== original.model) {
    throw new Error('Recovered usage differs from the persisted claim');
  }
  context.check();
  return context.db.transaction(async tx => {
    context.check();
    const [current] = await tx.select().from(postEvaluations).where(eq(postEvaluations.id, id)).for('update');
    context.check();
    if (!current || !recoverableUsage(current) || !current.receiptAuthority
      || !sameReceiptAuthority(current.receiptAuthority, originalAuthority)
      || current.fingerprint !== original.fingerprint || current.model !== original.model) return false;
    if (current.usageReconciliation) {
      if (!isDeepStrictEqual(current.usageReconciliation, evidence)) {
        throw new Error('Recovered usage conflicts with previously recorded evidence');
      }
      return true;
    }
    context.check();
    await tx.update(postEvaluations).set({ usageReconciliation: evidence,
      ...(current.state === 'claimed' ? { state: 'cost_uncertain' as const, finishedAt: new Date() } : {}),
    }).where(eq(postEvaluations.id, id));
    context.check();
    return true;
  });
}


/** Bounded maintenance read within the existing classifier cycle. */
export async function listUnreconciledPostEvaluations(release: ShadowRelease, authority: ShadowReceiptAuthority, afterId?: string, context?: ShadowReceiptDatabase): Promise<string[]> {
  if (!context) return withShadowReceiptDatabase(Date.now() + config.inference.timeoutMs, undefined,
    scoped => listUnreconciledPostEvaluations(release, authority, afterId, scoped));
  context.check();
  const rows = await context.db.select({ id: postEvaluations.id }).from(postEvaluations).where(and(
    or(inArray(postEvaluations.state, ['cost_uncertain', 'cancelled']),
      and(eq(postEvaluations.state, 'claimed'), lte(postEvaluations.requestDeadlineAt, new Date()))),
    isNull(postEvaluations.usageReconciliation),
    afterId === undefined ? undefined : gt(postEvaluations.id, afterId),
    eq(postEvaluations.receiptAuthority, shadowReceiptAuthoritySchema.parse(authority)), eq(postEvaluations.model, release.model),
    eq(postEvaluations.policyRef, release.policyRef), eq(postEvaluations.policyVersion, release.policyVersion),
    eq(postEvaluations.evaluationVersion, release.evaluationVersion),
  )).orderBy(asc(postEvaluations.id)).limit(25);
  context.check();
  return rows.map(row => row.id);
}
