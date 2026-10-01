import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  claimPostEvaluation, completePostEvaluation, markPostEvaluationUncertain, originalActorFollowState,
} from '../../db/posts/postEvaluationRepository';
import { replacePostContent, storeMachineVariant } from '../../db/posts/postRepository';
import { postEvaluations, postEvaluationTopics } from '../../db/schema/postEvaluations';
import { posts } from '../../db/schema/posts';
import { federatedActors, federatedFollows } from '../../db/schema/federation';
import { mapApVisibility } from '../../connectors/activitypub/helpers';
import { postContentVariants } from '../../db/schema/postContent';
import { postImports } from '../../db/schema/imports';
import { userSettings } from '../../db/schema/userProfile';
import { updateUserSettings } from '../../db/userProfile/userSettingsRepository';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import type { ShadowRelease, ShadowSignals } from '../../services/contentClassification/jevShadow';

const scope = postScope('jev-shadow-ledger');
const release: ShadowRelease = { model: 'synthetic/jev@fixture-v1', policyRef: 'fixture-policy',
  policyVersion: 1, evaluationVersion: 'shadow-v1', supportedLanguages: ['en'] };
const signals: ShadowSignals = { topics: [{ topic: 'science', probability: 0.9 }, { topic: 'news', probability: 0.8 }],
  languages: ['en'], languageEvidence: [{ language: 'en', probability: 0.9 }],
      sdkReceipt: { requestId: 'synthetic-request', routingPolicy: { routingPolicyId: 'fixture-policy', policyVersion: 1 },
        usage: [{ unit: 'requests', quantity: 1 }] }, spam: 0.1, repetition: 0.8, feedValue: 0.6 };

async function fixture() {
  const post = await seedPost(scope, {
    content: { variants: [{ source: 'author', tag: 'en', text: 'Synthetic science news.' }] },
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
  vi.restoreAllMocks();
  await clearPostScope(scope);
  await getDb().delete(federatedFollows).where(eq(federatedFollows.localUserId, scope.user('follower')));
  await getDb().delete(federatedActors).where(eq(federatedActors.domain, ACTOR_DOMAIN));
  await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, scope.user('author')));
});

const ACTOR_DOMAIN = 'jev-shadow-ledger.test';
const ORIGINAL = 'did:plc:jev-shadow-original';
async function seedRemoteActor(username: string, overrides: Partial<typeof federatedActors.$inferInsert> = {}) {
  const [actor] = await getDb().insert(federatedActors).values({
    uri: `https://${ACTOR_DOMAIN}/users/${username}`, username, domain: ACTOR_DOMAIN,
    acct: `${username}@${ACTOR_DOMAIN}`, oxyUserId: scope.user(`minted-${username}`), ...overrides,
  }).returning();
  return actor;
}
async function setProfile(visibility: 'public' | 'private' | 'followers_only') {
  await getDb().insert(userSettings).values({ oxyUserId: scope.user('author'), privacyProfileVisibility: visibility })
    .onConflictDoUpdate({ target: userSettings.oxyUserId, set: { privacyProfileVisibility: visibility } });
}
function barrier() {
  let open!: () => void;
  const reached = new Promise<void>(resolve => { open = resolve; });
  return { open, reached };
}
/** Resolves once some session is queued on the author's profile-visibility lock. */
async function untilProfileLockHasWaiter() {
  const key = `profile-visibility:${scope.user('author')}`;
  await vi.waitFor(async () => {
    const [row] = await getDb().execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_locks
      where locktype = 'advisory' and not granted
        and ((classid::bigint << 32) | objid::bigint) = hashtext(${key})::bigint`);
    expect(row?.waiting).toBeGreaterThan(0);
  }, { timeout: 3_000, interval: 10 });
}
const makePrivate = { set: { 'privacy.profileVisibility': 'followers_only' } };
async function followFixture(edges: Array<typeof federatedFollows.$inferInsert>) {
  if (edges.length) await getDb().insert(federatedFollows).values(edges);
  return getDb().transaction(async tx => {
    const state = await originalActorFollowState(tx, ORIGINAL);
    await tx.execute(sql`select 1`); // The surrounding write transaction stays usable.
    return state;
  });
}
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
    expect((await ledger(post.id))[0]).toMatchObject({ state: 'completed', spam: 0.1, repetition: 0.8, feedValue: 0.6,
      sdkReceipt: signals.sdkReceipt, languageEvidence: signals.languageEvidence });
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

  it('cascades completed SDK receipts and topic evidence on deletion', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    expect(await completePostEvaluation(claim, signals)).toBe(true);
    expect(await getDb().select().from(postEvaluationTopics)
      .where(eq(postEvaluationTopics.evaluationId, claim.id))).toHaveLength(2);
    await getDb().delete(posts).where(eq(posts.id, post.id));
    expect(await ledger(post.id)).toEqual([]);
    expect(await getDb().select().from(postEvaluationTopics)
      .where(eq(postEvaluationTopics.evaluationId, claim.id))).toEqual([]);
    expect(await completePostEvaluation(claim, signals)).toBe(false);
  });

  it('refuses a receipt for a different policy and mismatched language evidence', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await expect(completePostEvaluation(claim, { ...signals, sdkReceipt: {
      ...signals.sdkReceipt, routingPolicy: { routingPolicyId: 'different-policy', policyVersion: 1 },
    } })).rejects.toThrow(/policy receipt/);
    await expect(completePostEvaluation(claim, { ...signals, languages: ['es'],
      languageEvidence: [{ language: 'es', probability: 0.9 }],
    })).rejects.toThrow(/claimed evidence/);
    expect((await ledger(post.id))[0]).toMatchObject({ state: 'claimed', sdkReceipt: null, spam: null });
  });

  it('reads only accepted outbound follows of the original actor as follow evidence', async () => {
    expect(await followFixture([{ localUserId: scope.user('follower'), remoteActorUri: ORIGINAL,
      direction: 'outbound', status: 'accepted', network: 'atproto' }])).toBe('accepted');
  });

  it('does not count pending, inbound, or contextual actor edges as follows', async () => {
    expect(await followFixture([
      { localUserId: scope.user('follower'), remoteActorUri: ORIGINAL, direction: 'inbound', status: 'accepted' },
      { localUserId: scope.user('follower'), remoteActorUri: ORIGINAL, direction: 'outbound', status: 'pending' },
      { localUserId: scope.user('follower'), remoteActorUri: 'did:plc:contextual-actor', direction: 'outbound', status: 'accepted' },
    ])).toBe('not_followed');
  });

  it('refuses every federated source, listed or not, followed or not, before claiming', async () => {
    const unlisted = mapApVisibility(['https://jev-shadow-ledger.test/followers'],
      ['https://www.w3.org/ns/activitystreams#Public']);
    expect(unlisted).toBe(PostVisibility.PUBLIC); // The mapping that loses listed provenance.
    const listed = await seedRemoteActor('listed');
    const hidden = await seedRemoteActor('hidden', { discoverable: false });
    const suspended = await seedRemoteActor('suspended', { suspended: true });
    const bridged = await seedRemoteActor('bridged', { protocol: 'atproto', uri: ORIGINAL });
    await getDb().insert(federatedFollows).values({ localUserId: scope.user('follower'),
      remoteActorUri: ORIGINAL, direction: 'outbound', status: 'accepted', network: 'atproto' });
    const sources = [
      { visibility: unlisted, federation: { activityId: `${listed.uri}/statuses/unlisted`, actorUri: listed.uri } },
      { federation: { activityId: `${listed.uri}/statuses/listed`, actorUri: listed.uri } },
      { federation: { actorUri: hidden.uri } },
      { federation: { actorUri: suspended.uri } },
      { federation: { activityId: `at://${ORIGINAL}/app.bsky.feed.post/1`, actorUri: ORIGINAL } },
      { federation: { activityId: `${listed.uri}/statuses/activity-only` } },
      // A minted federated account with no federation columns on the row.
      { oxyUserId: bridged.oxyUserId ?? undefined },
    ];
    for (const overrides of sources) {
      const post = await seedPost(scope, {
        content: { variants: [{ source: 'author', tag: 'en', text: 'Synthetic remote science news.' }] },
        ...overrides,
      });
      await getDb().update(posts).set({ classificationLanguages: ['en'] }).where(eq(posts.id, post.id));
      expect(await claimPostEvaluation(post.id, release)).toBeNull();
      expect(await ledger(post.id)).toEqual([]);
    }
  });

  it('re-applies native eligibility at completion and cancels a result for a federated author', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await seedRemoteActor('late', { oxyUserId: post.oxyUserId });
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    expect((await ledger(post.id))[0]?.state).toBe('cancelled');
  });

  it('refuses imported posts, whatever their visibility mapping or follow state', async () => {
    const post = await fixture();
    await getDb().insert(postImports).values({ postId: post.id, oxyUserId: scope.user('author'),
      platform: 'mastodon', sourceId: `${post.id}-unlisted`, sourceUrl: `https://${ACTOR_DOMAIN}/@author/1`,
      importBatchId: 'synthetic-move-batch' });
    // A Move import carries no federation columns; following its source grants nothing.
    await getDb().insert(federatedFollows).values({ localUserId: scope.user('follower'),
      remoteActorUri: `https://${ACTOR_DOMAIN}/users/author`, direction: 'outbound', status: 'accepted' });
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
    expect(await ledger(post.id)).toEqual([]);
  });

  it('cancels an in-flight result when the post is imported after the claim', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await getDb().insert(postImports).values({ postId: post.id, oxyUserId: scope.user('author'),
      platform: 'mastodon', sourceId: `${post.id}-late`, sourceUrl: `https://${ACTOR_DOMAIN}/@author/2`,
      importBatchId: 'synthetic-move-batch' });
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    expect((await ledger(post.id))[0]?.state).toBe('cancelled');
  });

  it('requires a public author profile: no settings row is public, private and followers-only are not', async () => {
    expect(await claimPostEvaluation((await fixture()).id, release)).not.toBeNull(); // No settings row.
    await setProfile('public');
    expect(await claimPostEvaluation((await fixture()).id, release)).not.toBeNull();
    for (const visibility of ['private', 'followers_only'] as const) {
      await setProfile(visibility);
      const post = await fixture();
      await getDb().insert(federatedFollows).values({ localUserId: scope.user('follower'),
        remoteActorUri: `https://${ACTOR_DOMAIN}/users/${visibility}`, direction: 'outbound', status: 'accepted' });
      expect(await claimPostEvaluation(post.id, release)).toBeNull();
      expect(await ledger(post.id)).toEqual([]);
    }
  });

  it('fails closed for a post with no owner', async () => {
    const post = await fixture();
    await getDb().update(posts).set({ oxyUserId: null }).where(eq(posts.id, post.id));
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
    expect(await ledger(post.id)).toEqual([]);
  });

  it('cancels an in-flight result when the author makes the profile private', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await setProfile('followers_only');
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    expect((await ledger(post.id))[0]?.state).toBe('cancelled');
    await setProfile('public');
    // The cancelled row may have incurred cost: no second claim for that revision.
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
  });

  for (const row of ['existing', 'missing'] as const) {
    it(`cancels when a concurrent profile change (${row} settings row) takes the lock first`, async () => {
      if (row === 'existing') await setProfile('public');
      const post = await fixture();
      const claim = await requiredClaim(post.id);
      const writerHolds = barrier();
      const commitWriter = barrier();
      const writer = getDb().transaction(async tx => {
        await updateUserSettings(scope.user('author'), makePrivate, tx);
        writerHolds.open();
        await commitWriter.reached;
      });
      await writerHolds.reached;
      const completion = completePostEvaluation(claim, signals);
      try {
        await untilProfileLockHasWaiter(); // Completion is queued behind the uncommitted change.
      } finally {
        commitWriter.open(); // A failure must never leave a session holding the lock.
        await writer;
      }
      expect(await completion).toBe(false);
      expect((await ledger(post.id))[0]?.state).toBe('cancelled');
    });

    it(`serializes a concurrent profile change (${row} settings row) after a completion that holds the lock`, async () => {
      if (row === 'existing') await setProfile('public');
      const post = await fixture();
      const claim = await requiredClaim(post.id);
      const completionHolds = barrier();
      const commitCompletion = barrier();
      const transaction = getDb().transaction.bind(getDb());
      vi.spyOn(getDb(), 'transaction').mockImplementationOnce(callback => transaction(async tx => {
        const result = await callback(tx);
        completionHolds.open(); // Every check and the write are done; the commit waits.
        await commitCompletion.reached;
        return result;
      }));
      const completion = completePostEvaluation(claim, signals);
      await completionHolds.reached;
      let changed = false;
      const writer = updateUserSettings(scope.user('author'), makePrivate).then(() => { changed = true; });
      try {
        await untilProfileLockHasWaiter(); // The change is queued behind the completion.
        expect(changed).toBe(false);
      } finally {
        commitCompletion.open();
        await Promise.allSettled([completion, writer]);
      }
      expect(await completion).toBe(true);
      await writer;
      expect((await ledger(post.id))[0]?.state).toBe('completed');
      const [settings] = await getDb().select().from(userSettings).where(eq(userSettings.oxyUserId, scope.user('author')));
      expect(settings?.privacyProfileVisibility).toBe('followers_only');
      expect(await claimPostEvaluation((await fixture()).id, release)).toBeNull(); // Applied afterwards.
    });
  }

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

  it('keeps missing local follow evidence unknown', async () => {
    const post = await fixture();
    expect(await completePostEvaluation(await requiredClaim(post.id), signals)).toBe(true);
    expect((await ledger(post.id))[0]?.followState).toBe('unknown');
  });

  it('recovers from a failed follow query using the savepoint and records unknown', async () => {
    const state = await getDb().transaction(async tx => {
      const savepoint = tx.transaction.bind(tx);
      vi.spyOn(tx, 'transaction').mockImplementationOnce(() => savepoint(async lookup => {
        await lookup.execute(sql`select 1 / 0`);
        throw new Error('Division by zero must fail inside the follow savepoint');
      }));
      const result = await originalActorFollowState(tx, ORIGINAL);
      await tx.execute(sql`select 1`); // Not poisoned: the final write could still commit.
      return result;
    });
    expect(state).toBe('unknown');
  });

  it('refuses boosts, followers-only and restricted posts before claiming', async () => {
    const original = await fixture();
    const boost = await fixture();
    await getDb().update(posts).set({ type: 'boost', boostOf: original.id }).where(eq(posts.id, boost.id));
    expect(await claimPostEvaluation(boost.id, release)).toBeNull();
    for (const patch of [{ visibility: 'followers_only' as const }, { status: 'restricted' as const }]) {
      const post = await fixture();
      await getDb().update(posts).set(patch).where(eq(posts.id, post.id));
      expect(await claimPostEvaluation(post.id, release)).toBeNull();
      expect(await ledger(post.id)).toEqual([]);
    }
  });

  it('keeps cancellation after a privacy toggle from authorizing a second paid request', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await getDb().update(posts).set({ visibility: 'private' }).where(eq(posts.id, post.id));
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    await getDb().update(posts).set({ visibility: 'public' }).where(eq(posts.id, post.id));
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
    expect((await ledger(post.id))[0]?.state).toBe('cancelled');
  });

  it('keeps a result when a machine translation is cached or replaced during inference', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    const translation = { tag: 'es', source: 'machine' as const, text: 'Noticias científicas sintéticas.' };
    const options = { sourceMatches: () => true };
    expect((await storeMachineVariant(post.id, translation, { ...options, force: false })).kind).toBe('stored');
    expect((await storeMachineVariant(post.id, { ...translation, text: 'Otra traducción.' }, { ...options, force: true })).kind)
      .toBe('stored');
    expect(await completePostEvaluation(claim, signals)).toBe(true);
    expect((await ledger(post.id))[0]?.state).toBe('completed');
    // Same author revision: no second claim, so no second paid request.
    expect(await claimPostEvaluation(post.id, release)).toBeNull();
  });

  it('still cancels when an author rendition is added during inference', async () => {
    const post = await fixture();
    const claim = await requiredClaim(post.id);
    await getDb().insert(postContentVariants).values({ postId: post.id, position: 1,
      tag: 'es', source: 'author', body: 'Noticias científicas sintéticas.' });
    expect(await completePostEvaluation(claim, signals)).toBe(false);
    expect((await ledger(post.id))[0]?.state).toBe('cancelled');
  });
});
