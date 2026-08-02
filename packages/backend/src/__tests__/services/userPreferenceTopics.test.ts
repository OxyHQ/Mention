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
 * `UserBehavior` is still Mongoose and stays mocked: the accumulator it holds is
 * what these tests are about, and it is not part of this port.
 */

const mocks = vi.hoisted(() => ({ findOne: vi.fn() }));

vi.mock('../../models/UserBehavior', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => mocks.findOne(filter) },
}));
vi.mock('../../models/Like', () => ({ __esModule: true, default: { find: vi.fn() } }));
vi.mock('../../models/Bookmark', () => ({ __esModule: true, default: { find: vi.fn() } }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { userPreferenceService } from '../../services/UserPreferenceService';

interface TopicPref {
  topic: string;
  topicId?: string;
  weight: number;
  interactionCount: number;
  lastInteractionAt: Date;
}

interface MockBehavior {
  oxyUserId: string;
  preferredAuthors: unknown[];
  preferredTopics: TopicPref[];
  preferredPostTypes: Record<string, number>;
  activeHours: number[];
  preferredLanguages: string[];
  hiddenAuthors: string[];
  mutedAuthors: string[];
  blockedAuthors: string[];
  hiddenTopics: string[];
  lastUpdated?: Date;
  markModified: () => void;
  save: () => Promise<void>;
}

const scope = serviceScope('user-pref-topics');
const VIEWER = scope.user('viewer');

function makeBehavior(): MockBehavior {
  return {
    oxyUserId: VIEWER,
    preferredAuthors: [],
    preferredTopics: [],
    preferredPostTypes: { text: 0, image: 0, video: 0, poll: 0 },
    activeHours: [],
    preferredLanguages: [],
    hiddenAuthors: [],
    mutedAuthors: [],
    blockedAuthors: [],
    hiddenTopics: [],
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

let behavior: MockBehavior;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  behavior = makeBehavior();
  mocks.findOne.mockResolvedValue(behavior);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

function prefByTopic(name: string): TopicPref | undefined {
  return behavior.preferredTopics.find((t) => t.topic === name);
}

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

    expect(prefByTopic('basketball')?.topicId).toBe('topic-basketball');
    expect(prefByTopic('lakers')?.topicId).toBe('topic-lakers');
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });

  it('FALLS BACK to the slug-only postClassification.topics (name only, no topicId) when no topicRefs row exists', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: ['cooking'] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    // The slug list is name-only: the preference is learned by name, with no
    // resolved topicId (only topicRefs carry one).
    const pref = prefByTopic('cooking');
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
    expect(behavior.preferredTopics.map((t) => t.topic)).toEqual(['basketball']);
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

    const pref = prefByTopic('gardening');
    expect(pref).toBeDefined();
    expect(pref?.interactionCount).toBe(1);
    expect(pref?.weight).toBeGreaterThan(0);
  });

  it('scales the learned weight by a stored relevance', async () => {
    // The relevance column is the whole reason `topicRefs` beats the slug list,
    // so a ref stored at a fraction must accrue proportionally less than a ref
    // stored with none. Two posts, one interaction each, same interaction type.
    const weak = await seedPost(scope, {
      postClassification: {
        status: 'classified',
        topicRefs: [{ name: 'chess', topicId: 'topic-chess', relevance: 0.25 }],
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

    const weakWeight = prefByTopic('chess')?.weight ?? 0;
    const fullWeight = prefByTopic('sailing')?.weight ?? 0;
    expect(weakWeight).toBeGreaterThan(0);
    expect(weakWeight).toBeCloseTo(fullWeight * 0.25, 6);
  });

  it('learns NO classified topic when the stored post carries neither encoding', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    expect(behavior.preferredTopics).toHaveLength(0);
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });
});
