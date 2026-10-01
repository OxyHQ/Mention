import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb, type Transaction } from '../postgres';
import { posts } from '../schema/posts';
import { postContentVariants } from '../schema/postContent';
import { postEvaluations, postEvaluationTopics } from '../schema/postEvaluations';
import { federatedFollows } from '../schema/federation';
import { lockPostContent } from './postRepository';
import { logger } from '../../utils/logger';
import {
  shadowAbstention, shadowFingerprint, shadowSignalsSchema, validateShadowRelease,
  type ShadowRelease, type ShadowSignals, type ShadowSnapshot,
} from '../../services/contentClassification/jevShadow';

/** Lock order matches content writers: rendition advisory lock, then post row. */
async function lockSnapshot(tx: Transaction, postId: string): Promise<ShadowSnapshot | null> {
  await lockPostContent(tx, postId);
  const [post] = await tx.select({
    actorUri: posts.federationActorUri,
    owner: posts.oxyUserId,
    languages: posts.classificationLanguages,
  }).from(posts).where(and(
    eq(posts.id, postId), eq(posts.visibility, 'public'), eq(posts.status, 'published'),
    isNull(posts.boostOf),
  )).for('update');
  if (!post) return null;
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
export async function claimPostEvaluation(postId: string, release: ShadowRelease): Promise<ShadowClaim | null> {
  validateShadowRelease(release);
  return getDb().transaction(async tx => {
    const snapshot = await lockSnapshot(tx, postId);
    if (!snapshot) return null;
    const fingerprint = shadowFingerprint(snapshot);
    const abstention = shadowAbstention(snapshot, release);
    const [claim] = await tx.insert(postEvaluations).values({
      postId, fingerprint, model: release.model, policyRef: release.policyRef,
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
 */
async function originalActorFollowState(tx: Transaction, actorUri: string | null) {
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
  return getDb().transaction(async tx => {
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
      feedValue: signals.feedValue,
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
