import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { claimPostEvaluation, completePostEvaluation, markPostEvaluationUncertain } from '../../db/posts/postEvaluationRepository';
import { replacePostContent } from '../../db/posts/postRepository';
import { postEvaluations, postEvaluationTopics } from '../../db/schema/postEvaluations';
import { posts } from '../../db/schema/posts';
import { federatedFollows } from '../../db/schema/federation';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import type { ShadowRelease, ShadowSignals } from '../../services/contentClassification/jevShadow';

const scope = postScope('jev-shadow-ledger');
const release: ShadowRelease = { model: 'synthetic/jev@fixture-v1', policyRef: 'fixture-policy',
  policyVersion: 1, evaluationVersion: 'shadow-v1', supportedLanguages: ['en'] };
const signals: ShadowSignals = { topics: [{ topic: 'science', probability: 0.9 }, { topic: 'news', probability: 0.8 }],
  languages: ['en'], spam: 0.1, repetition: 0.8, feedValue: 0.6 };

async function fixture() {
  const post = await seedPost(scope, {
    content: { variants: [{ source: 'author', tag: 'en', text: 'Synthetic science news.' }] },
    federation: { actorUri: 'did:plc:jev-shadow-original' },
  });
  await getDb().update(posts).set({ classificationLanguages: ['en'] }).where(eq(posts.id, post.id));
  return post;
}
async function requiredClaim(postId: string) {
  const claim = await claimPostEvaluation(postId, release);
  if (!claim) throw new Error('Synthetic fixture was not claimed');
  return claim;
}
async function ledger(postId: string) {
  return getDb().select().from(postEvaluations).where(eq(postEvaluations.postId, postId));
}

beforeAll(() => connectPostgres());
afterEach(async () => {
  await clearPostScope(scope);
  await getDb().delete(federatedFollows).where(eq(federatedFollows.localUserId, scope.user('follower')));
});
afterAll(() => closePostgres());

describe('durable shadow evaluation ledger', () => {
  it('allows only one concurrent claim and never reclaims uncertain or abandoned work', async () => {
    const post = await fixture();
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimPostEvaluation(post.id, release)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(value => value !== null);
    if (!claim) throw new Error('No claim');
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
    await markPostEvaluationUncertain(claim);
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
    expect((await ledger(post.id))[0]?.state).toBe('cost_uncertain');
  });

  it('stores separate signals once without changing canonical classification or ranking', async () => {
    const post = await fixture();
    const [before] = await getDb().select().from(posts).where(eq(posts.id, post.id));
    const claim = await requiredClaim(post.id);
    expect(await completePostEvaluation(claim, signals)).toBe(true);
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    expect(await getDb().select().from(posts).where(eq(posts.id, post.id))).toEqual([before]);
    expect((await ledger(post.id))[0]).toMatchObject({ state: 'completed', spam: 0.1, repetition: 0.8, feedValue: 0.6 });
    expect(await getDb().select().from(postEvaluationTopics).where(eq(postEvaluationTopics.evaluationId, claim.id))).toHaveLength(2);
  });

  it('cancels an old result after a rendition edit, including identical-text replacement', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await replacePostContent(post.id, post.content, []);
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    expect((await ledger(post.id))[0]?.state).toBe('cancelled');
    expect(await claimPostEvaluation(post.id, release)).not.toBeNull();
  });

  it('accepts unrelated updatedAt changes and rejects private or unpublished final state', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await getDb().update(posts).set({ updatedAt: new Date('2030-01-01') }).where(eq(posts.id, post.id));
    expect(await completePostEvaluation(claim, signals)).toBe(true);
    for (const patch of [{ visibility: PostVisibility.PRIVATE }, { status: 'draft' as const }]) {
      const other = await fixture();
      const pending = await requiredClaim(other.id);
      await getDb().update(posts).set(patch).where(eq(posts.id, other.id));
      expect(await completePostEvaluation(pending, signals)).toBe(false);
      expect(await claimPostEvaluation(other.id, release)).toBeNull();
    }
  });

  it('deletion cascades pending/results and prevents result resurrection', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await getDb().delete(posts).where(eq(posts.id, post.id));
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    await markPostEvaluationUncertain(claim);
    expect(await ledger(post.id)).toEqual([]);
  });

  it('re-reads accepted outbound follows of the original DID at completion', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await getDb().insert(federatedFollows).values({ localUserId: scope.user('follower'),
      remoteActorUri: 'did:plc:jev-shadow-original', direction: 'outbound', status: 'accepted', network: 'atproto' });
    expect(await completePostEvaluation(claim, signals)).toBe(true);
    expect((await ledger(post.id))[0]?.followState).toBe('accepted');
  });

  it('does not count pending, inbound, or contextual actor edges as follows', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await getDb().insert(federatedFollows).values([
      { localUserId: scope.user('follower'), remoteActorUri: 'did:plc:jev-shadow-original', direction: 'inbound', status: 'accepted' },
      { localUserId: scope.user('follower'), remoteActorUri: 'did:plc:jev-shadow-original', direction: 'outbound', status: 'pending' },
      { localUserId: scope.user('follower'), remoteActorUri: 'did:plc:contextual-actor', direction: 'outbound', status: 'accepted' },
    ]);
    expect(await completePostEvaluation(claim, signals)).toBe(true);
    expect((await ledger(post.id))[0]?.followState).toBe('not_followed');
  });

  it('abstains without inferring or recording low scores for unsupported and media-only posts', async () => {
    const post = await fixture();
    await getDb().update(posts).set({ classificationLanguages: ['ja'] }).where(eq(posts.id, post.id));
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
    expect((await ledger(post.id))[0]).toMatchObject({ state: 'abstained', abstention: 'unsupported_language', feedValue: null });
    const media = await fixture();
    await replacePostContent(media.id, { variants: [] }, []);
    expect(await claimPostEvaluation(media.id, release)).toBeNull();
    expect((await ledger(media.id))[0]).toMatchObject({ state: 'abstained', abstention: 'no_primary_text', spam: null });
  });

  it('keys deduplication independently by immutable model, policy and evaluation version', async () => {
    const post = await fixture();
    await requiredClaim(post.id);
    for (const next of [{ ...release, policyVersion: 2 }, { ...release, model: 'synthetic/jev@fixture-v2' },
      { ...release, evaluationVersion: 'shadow-v2' }]) {
      expect(await claimPostEvaluation(post.id, next)).not.toBeNull();
    }
    expect(await ledger(post.id)).toHaveLength(4);
  });
});
