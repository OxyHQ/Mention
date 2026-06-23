import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link UserPreferenceService} topic-preference learning off
 * the CANONICAL classified topics. The service must PREFER
 * `postClassification.topicRefs` (registry-linked), FALL BACK to legacy
 * `extracted.topics`, and learn NO topic when neither is present.
 *
 * The Post and UserBehavior models are mocked (no DB). We drive a single positive
 * `like` interaction and assert the topic-preference entries written onto the
 * in-memory UserBehavior — specifically the topic `name`, the resolved `topicId`,
 * and that an absent relevance scales by the full weight (factor 1).
 */

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

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: { findById: (id: string) => ({ lean: () => mocks.findById(id) }) },
}));
vi.mock('../../models/UserBehavior', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => mocks.findOne(filter),
  },
}));
vi.mock('../../models/Like', () => ({ __esModule: true, default: { find: vi.fn() } }));
vi.mock('../../models/Bookmark', () => ({ __esModule: true, default: { find: vi.fn() } }));

import { userPreferenceService } from '../../services/UserPreferenceService';

function makeBehavior(): MockBehavior {
  return {
    oxyUserId: 'viewer-1',
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

beforeEach(() => {
  vi.clearAllMocks();
  behavior = makeBehavior();
  mocks.findOne.mockResolvedValue(behavior);
});

function prefByTopic(name: string): TopicPref | undefined {
  return behavior.preferredTopics.find(t => t.topic === name);
}

describe('UserPreferenceService — canonical topic learning (topicRefs prefer / extracted fallback / neutral)', () => {
  it('learns topics from postClassification.topicRefs with the resolved topicId', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p1',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: {
        status: 'classified',
        topics: ['basketball', 'lakers'],
        topicRefs: [
          { name: 'basketball', topicId: 'topic-basketball' },
          { name: 'lakers', topicId: 'topic-lakers' },
        ],
      },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p1', 'like');

    expect(prefByTopic('basketball')?.topicId).toBe('topic-basketball');
    expect(prefByTopic('lakers')?.topicId).toBe('topic-lakers');
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });

  it('FALLS BACK to extracted.topics (with relevance + topicId) when topicRefs is absent', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p2',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      extracted: {
        topics: [{ name: 'cooking', type: 'topic', relevance: 8, topicId: 'topic-cooking' }],
      },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p2', 'like');

    expect(prefByTopic('cooking')?.topicId).toBe('topic-cooking');
  });

  it('PREFERS topicRefs over extracted.topics when both are present', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p3',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: {
        status: 'classified',
        topics: ['basketball'],
        topicRefs: [{ name: 'basketball', topicId: 'topic-basketball' }],
      },
      extracted: {
        topics: [{ name: 'cooking', type: 'topic', relevance: 9, topicId: 'topic-cooking' }],
      },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p3', 'like');

    // Only the canonical topicRefs topic is learned; the extracted one is ignored.
    expect(prefByTopic('basketball')).toBeDefined();
    expect(prefByTopic('cooking')).toBeUndefined();
  });

  it('treats an absent relevance (slug-only topicRefs) as full weight (no zeroing)', async () => {
    // topicRef without relevance → relevance factor 1 → a non-zero preference
    // weight is accrued. A factor-0 bug would leave interactionCount at 0.
    mocks.findById.mockResolvedValue({
      _id: 'p4',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: {
        status: 'classified',
        topics: ['gardening'],
        topicRefs: [{ name: 'gardening', topicId: 'topic-gardening' }],
      },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p4', 'like');

    const pref = prefByTopic('gardening');
    expect(pref).toBeDefined();
    expect(pref?.interactionCount).toBeGreaterThan(0);
  });

  it('learns NO classified topic when neither topicRefs nor extracted.topics is present', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p5',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: { status: 'baseline', topics: [] },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p5', 'like');

    expect(behavior.preferredTopics).toHaveLength(0);
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });
});
