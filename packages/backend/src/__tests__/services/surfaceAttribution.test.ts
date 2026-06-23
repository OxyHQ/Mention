import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isVideoSurface, MtnConfig } from '@mention/shared-types';

/**
 * Surface-aware engagement attribution.
 *
 * Two layers are tested:
 *  1. `isVideoSurface` — the pure classifier shared by UserBehavior attribution
 *     and the recommendation engagement scan.
 *  2. `UserPreferenceService.recordInteraction` — that a like from the Videos
 *     surface DAMPENS author affinity and AMPLIFIES content (post-type/topic)
 *     affinity, while a like from a normal feed uses full attribution.
 */

const mocks = vi.hoisted(() => ({
  postFindById: vi.fn(),
  behaviorFindOne: vi.fn(),
}));

vi.mock('../../models/Post', () => ({ Post: { findById: mocks.postFindById } }));
vi.mock('../../models/UserBehavior', () => ({ default: { findOne: mocks.behaviorFindOne } }));
// Like/Bookmark are imported by the service but unused on the recordInteraction path.
vi.mock('../../models/Like', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));

import { userPreferenceService } from '../../services/UserPreferenceService';

describe('isVideoSurface', () => {
  it('classifies the canonical video surfaces', () => {
    expect(isVideoSurface('videos')).toBe(true);
    expect(isVideoSurface('VIDEOS')).toBe(true);
    expect(isVideoSurface('reels')).toBe(true);
    expect(isVideoSurface('videos|trending')).toBe(true); // scoped descriptor
  });

  it('does NOT classify non-video surfaces', () => {
    expect(isVideoSurface('for_you')).toBe(false);
    expect(isVideoSurface('following')).toBe(false);
    expect(isVideoSurface('author|user_1')).toBe(false);
    expect(isVideoSurface('hashtag|video')).toBe(false); // a tag named "video" is not the videos feed
  });

  it('returns false for absent/blank input (default full-attribution path)', () => {
    expect(isVideoSurface(undefined)).toBe(false);
    expect(isVideoSurface(null)).toBe(false);
    expect(isVideoSurface('')).toBe(false);
    expect(isVideoSurface('   ')).toBe(false);
  });
});

/**
 * A minimal Mongoose-document-like UserBehavior stub: an object whose array/obj
 * fields are real (so the service can push/index into them) plus the no-op
 * `markModified` and `save` the service calls.
 */
function makeBehaviorDoc() {
  return {
    oxyUserId: 'viewer_1',
    preferredAuthors: [] as Array<Record<string, unknown>>,
    preferredTopics: [] as Array<Record<string, unknown>>,
    preferredPostTypes: { text: 0, image: 0, video: 0, poll: 0 } as Record<string, number>,
    activeHours: [] as number[],
    preferredLanguages: [] as string[],
    hiddenAuthors: [] as string[],
    mutedAuthors: [] as string[],
    blockedAuthors: [] as string[],
    hiddenTopics: [] as string[],
    lastUpdated: new Date(),
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function mockPost(post: Record<string, unknown>) {
  mocks.postFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(post) });
}

describe('UserPreferenceService surface-aware attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a VIDEO-surface like dampens author affinity vs a normal-surface like', async () => {
    const videoPost = { _id: 'p1', oxyUserId: 'author_1', type: 'video', hashtags: [] };

    const normalDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(normalDoc);
    mockPost(videoPost);
    await userPreferenceService.recordInteraction('viewer_1', 'p1', 'like', { surface: 'for_you' });
    // The stored relationship `weight` (what ranking consumes) is the dampened
    // value — interactionCount is a side metric and is NOT surface-scaled.
    const normalAuthorWeight = normalDoc.preferredAuthors.find((a) => a.authorId === 'author_1')
      ?.weight as number;

    const videoDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(videoDoc);
    mockPost(videoPost);
    await userPreferenceService.recordInteraction('viewer_1', 'p1', 'like', { surface: 'videos' });
    const videoAuthorWeight = videoDoc.preferredAuthors.find((a) => a.authorId === 'author_1')
      ?.weight as number;

    expect(normalAuthorWeight).toBeGreaterThan(0);
    expect(videoAuthorWeight).toBeGreaterThan(0);
    // The reels like accrues the configured fraction of author affinity weight.
    expect(videoAuthorWeight).toBeCloseTo(
      normalAuthorWeight * MtnConfig.preferences.engagementContext.videoSurfaceAuthorAffinityFactor,
      5,
    );
  });

  it('a VIDEO-surface like amplifies post-type (content) affinity vs a normal-surface like', async () => {
    const videoPost = { _id: 'p1', oxyUserId: 'author_1', type: 'video', hashtags: [] };

    const normalDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(normalDoc);
    mockPost(videoPost);
    await userPreferenceService.recordInteraction('viewer_1', 'p1', 'like', { surface: 'for_you' });
    const normalVideoTypePref = normalDoc.preferredPostTypes.video;

    const videoDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(videoDoc);
    mockPost(videoPost);
    await userPreferenceService.recordInteraction('viewer_1', 'p1', 'like', { surface: 'videos' });
    const videoVideoTypePref = videoDoc.preferredPostTypes.video;

    expect(normalVideoTypePref).toBeGreaterThan(0);
    // Content (post-type) affinity is amplified on the video surface.
    expect(videoVideoTypePref).toBeCloseTo(
      normalVideoTypePref * MtnConfig.preferences.engagementContext.videoSurfaceContentBoost,
      5,
    );
    expect(videoVideoTypePref).toBeGreaterThan(normalVideoTypePref);
  });

  it('no context behaves exactly like a normal-surface like (backward compatible)', async () => {
    const post = { _id: 'p1', oxyUserId: 'author_1', type: 'video', hashtags: [] };

    const ctxDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(ctxDoc);
    mockPost(post);
    await userPreferenceService.recordInteraction('viewer_1', 'p1', 'like', { surface: 'for_you' });
    const ctxWeight = ctxDoc.preferredAuthors.find((a) => a.authorId === 'author_1')
      ?.weight as number;

    const noCtxDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(noCtxDoc);
    mockPost(post);
    await userPreferenceService.recordInteraction('viewer_1', 'p1', 'like');
    const noCtxWeight = noCtxDoc.preferredAuthors.find((a) => a.authorId === 'author_1')
      ?.weight as number;

    expect(noCtxWeight).toBeCloseTo(ctxWeight, 5);
  });
});
