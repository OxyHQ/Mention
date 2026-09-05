import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for {@link UserPreferenceService} topic-preference learning off the
 * CANONICAL classified topics. The service must PREFER
 * `postClassification.topicRefs` (registry-linked), FALL BACK to the slug-only
 * `postClassification.topics`, and learn NO topic when neither is present.
 *
 * ## What changed with the Postgres port
 *
 * The two topic encodings are stored DIFFERENTLY now — `topics` is an array
 * column on `posts`, `topicRefs` is a child table — and the preference rule that
 * one wins over the other only means anything if both survive the round trip.
 * The old suite mocked `models/Post` and handed the service a literal object
 * carrying both, so it proved the service prefers one key of an object over
 * another; it could not have noticed `topicRefs` failing to be written, or being
 * read back in a different order than it was inserted. Every post here is a real
 * row inserted through `insertPostRecord` and read back by the service itself.
 *
 * `preferredTopics` is a child TABLE now, and its `interaction_count` is the
 * column this port had to widen from `integer` to `double precision`: a
 * relevance-scaled learn accrues 0.2, which postgres.js sends as a parameter an
 * `integer` column REJECTS outright. The relevance case below is therefore also
 * the regression test for that column type.
 */

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { eq } from 'drizzle-orm';
import { userBehaviors } from '../../db/schema/userProfile';
import type { TopicPreference } from '../../db/userProfile/userBehaviorRecord';
import {
  deleteUserBehavior,
  loadUserBehavior,
} from '../../db/userProfile/userBehaviorRepository';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { userPreferenceService } from '../../services/UserPreferenceService';

const scope = serviceScope('user-pref-topics');
const VIEWER = scope.user('viewer');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  await deleteUserBehavior(VIEWER);
});

afterEach(async () => {
  await clearServiceScope(scope);
  await deleteUserBehavior(VIEWER);
});

afterAll(async () => {
  await closePostgres();
});

/** Every topic preference the viewer has stored, strongest first. */
async function storedTopics(): Promise<TopicPreference[]> {
  return (await loadUserBehavior(VIEWER))?.preferredTopics ?? [];
}

async function prefByTopic(name: string): Promise<TopicPreference | undefined> {
  return (await storedTopics()).find((t) => t.topic === name);
}

/**
 * The language-learning loop is GONE, and this is the assertion that keeps it
 * gone.
 *
 * `recordInteraction` used to append `post.language` to
 * `user_behaviors.preferred_languages` — outside the `isPositiveSignal` guard, so
 * a SKIP wrote to it too; unbounded, unweighted, never decayed. That array then
 * drove a For You candidate lane and a x1.2 ranking boost, which closed the loop:
 * a German post appears, you scroll past it, `de` is learned, more German
 * appears. Measured on production 2026-09-05, the For You page was 48% `de`
 * against a corpus that is 6.8% `de`.
 *
 * The reader's DECLARED languages replaced it (Oxy account, else
 * `Accept-Language`) — an input that cannot drift toward whatever the feed
 * happened to show. The COLUMN still exists, because dropping it has to wait for
 * a release in which no running image selects it; what must never come back is
 * the write.
 */
describe('UserPreferenceService — language is DECLARED, never learned', () => {
  /** The raw column, read directly: the record type no longer exposes it. */
  async function storedLanguages(): Promise<string[] | null> {
    const [row] = await getDb()
      .select({ preferredLanguages: userBehaviors.preferredLanguages })
      .from(userBehaviors)
      .where(eq(userBehaviors.oxyUserId, VIEWER));
    return row?.preferredLanguages ?? null;
  }

  it('learns NO language from a skipped off-language post', async () => {
    const post = await seedPost(scope, {
      language: 'de',
      postClassification: { status: 'baseline', topics: ['politics'], languages: ['de'] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'skip');

    expect(await storedLanguages()).toEqual(null);
  });

  /**
   * POSITIVE CONTROL. Without it, "no language was learned" is satisfied by a
   * service that recorded nothing at all — a broken fixture, a rejected write, a
   * viewer id that never matched. A LIKE on the same shape of post must still
   * learn the topic, which proves the interaction landed and that only the
   * language half is gone.
   */
  it('still learns the TOPIC from the same post, so the assertion above is not vacuous', async () => {
    const post = await seedPost(scope, {
      language: 'de',
      postClassification: { status: 'baseline', topics: ['politics'], languages: ['de'] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    expect(await prefByTopic('politics')).toBeDefined();
    expect(await storedLanguages()).toEqual(null);
  });
});

describe('UserPreferenceService — canonical topic learning (topicRefs prefer / slug-topics fallback / neutral)', () => {
  it('learns topics from the stored topicRefs rows, with their resolved topicId', async () => {
    const post = await seedPost(scope, {
      postClassification: {
        status: 'classified',
        topics: ['basketball', 'lakers'],
        topicRefs: [
          { name: 'basketball', topicId: 'topic-basketball' },
          { name: 'lakers', topicId: 'topic-lakers' },
        ],
      },
    });

    // The refs are a child table: prove they came back before asserting on what
    // the service did with them, so a write that never landed reads as a storage
    // failure rather than a preference-learning one.
    const stored = await readPost(post.id);
    expect(stored?.postClassification.topicRefs?.map((ref) => ref.name)).toEqual([
      'basketball',
      'lakers',
    ]);

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    expect((await prefByTopic('basketball'))?.topicId).toBe('topic-basketball');
    expect((await prefByTopic('lakers'))?.topicId).toBe('topic-lakers');
  });

  it('FALLS BACK to the slug-only postClassification.topics (name only, no topicId) when no topicRefs row exists', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: ['cooking'] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    // The slug list is name-only: the preference is learned by name, with no
    // resolved topicId (only topicRefs carry one).
    const pref = await prefByTopic('cooking');
    expect(pref).toBeDefined();
    expect(pref?.topicId).toBeUndefined();
  });

  it('PREFERS topicRefs over the slug list when both are stored', async () => {
    const post = await seedPost(scope, {
      postClassification: {
        status: 'classified',
        topics: ['basketball', 'cooking'],
        topicRefs: [{ name: 'basketball', topicId: 'topic-basketball' }],
      },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    // Only the canonical topicRefs topic is learned; the extra slug-only topic
    // (`cooking`, in the `topics` column but with no ref row) is ignored.
    expect((await storedTopics()).map((t) => t.topic)).toEqual(['basketball']);
  });

  it('treats an absent relevance (slug-only topicRef) as full weight (no zeroing)', async () => {
    // A topicRef row whose `relevance` column is NULL → relevance factor 1 → a
    // non-zero preference weight accrues. A factor-0 bug would leave
    // interactionCount at 0.
    const post = await seedPost(scope, {
      postClassification: {
        status: 'classified',
        topics: ['gardening'],
        topicRefs: [{ name: 'gardening', topicId: 'topic-gardening' }],
      },
    });
    expect((await readPost(post.id))?.postClassification.topicRefs?.[0].relevance).toBeUndefined();

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    const pref = await prefByTopic('gardening');
    expect(pref).toBeDefined();
    expect(pref?.interactionCount).toBe(1);
    expect(pref?.weight).toBeGreaterThan(0);
  });

  it('scales the learned weight by a stored relevance', async () => {
    // The relevance column is the whole reason `topicRefs` beats the slug list,
    // so a ref stored low on the 1..10 scale must accrue proportionally less
    // than a ref stored with none (which scales by the full weight). Two posts,
    // one interaction each, same interaction type.
    const weak = await seedPost(scope, {
      postClassification: {
        status: 'classified',
        topicRefs: [{ name: 'chess', topicId: 'topic-chess', relevance: 2 }],
      },
    });
    const full = await seedPost(scope, {
      postClassification: {
        status: 'classified',
        topicRefs: [{ name: 'sailing', topicId: 'topic-sailing' }],
      },
    });

    await userPreferenceService.recordInteraction(VIEWER, weak.id, 'like');
    await userPreferenceService.recordInteraction(VIEWER, full.id, 'like');

    const weak_ = await prefByTopic('chess');
    const full_ = await prefByTopic('sailing');
    // The stored count is FRACTIONAL (1.0 x relevance 2/10). An `integer`
    // column would have refused the write outright, so reading it back at 0.2
    // is what proves the widened column is in place.
    expect(weak_?.interactionCount).toBeCloseTo(0.2, 6);
    const weakWeight = weak_?.weight ?? 0;
    const fullWeight = full_?.weight ?? 0;
    expect(weakWeight).toBeGreaterThan(0);
    // `relevance / 10` is the factor the service applies, so 2 → one fifth.
    expect(weakWeight).toBeCloseTo(fullWeight * 0.2, 6);
  });

  it('learns NO classified topic when the stored post carries neither encoding', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    expect(await storedTopics()).toHaveLength(0);
    // The interaction still landed — an empty topic set is also what a write
    // that never happened looks like, so assert a positive effect too.
    expect((await loadUserBehavior(VIEWER))?.preferredPostTypes.text).toBe(1);
  });
});
