import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isVideoSurface, MtnConfig, PostType } from '@mention/shared-types';

/**
 * Surface-aware engagement attribution.
 *
 * Two layers are tested:
 *  1. `isVideoSurface` — the pure classifier shared by UserBehavior attribution
 *     and the recommendation engagement scan.
 *  2. `UserPreferenceService.recordInteraction` — that a like from the Videos
 *     surface DAMPENS author affinity and AMPLIFIES content (post-type/topic)
 *     affinity, while a like from a normal feed uses full attribution.
 *
 * ## What changed with the Postgres port
 *
 * The engaged post is a REAL `type: 'video'` row. Previously it was a literal
 * `{ type: 'video' }` returned by a `models/Post` mock, which meant the
 * post-type half of the assertion ("a video like grows `preferredPostTypes.video`")
 * measured a string the test itself supplied. `type` is a stored column now, so
 * a post whose type is written or read back wrong shows up as the wrong
 * accumulator moving.
 *
 * `UserBehavior` is still Mongoose and stays mocked — it holds the accumulators
 * under test and is not part of this port.
 */

const mocks = vi.hoisted(() => ({ behaviorFindOne: vi.fn() }));

vi.mock('../../models/UserBehavior', () => ({ default: { findOne: mocks.behaviorFindOne } }));
// Like/Bookmark are imported by the service but unused on the recordInteraction path.
vi.mock('../../models/Like', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
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

const scope = serviceScope('surface-attribution');
const VIEWER = scope.user('viewer');
const AUTHOR = scope.user('author');

/**
 * A minimal Mongoose-document-like UserBehavior stub: an object whose array/obj
 * fields are real (so the service can push/index into them) plus the no-op
 * `markModified` and `save` the service calls.
 */
function makeBehaviorDoc() {
  return {
    oxyUserId: VIEWER,
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

/** The one video post every attribution case below engages with. */
let videoPostId: string;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  videoPostId = (
    await seedPost(scope, {
      oxyUserId: AUTHOR,
      type: PostType.VIDEO,
      content: {
        variants: [{ source: 'author', text: 'a reel', tag: 'en' }],
        media: [{ id: 'file-1', type: 'video' }],
      },
    })
  ).id;
  // The post-type half of every assertion below reads `preferredPostTypes.video`,
  // which only moves because the STORED type is `video`. Pin it once.
  expect((await readPost(videoPostId))?.type).toBe(PostType.VIDEO);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('UserPreferenceService surface-aware attribution', () => {
  it('a VIDEO-surface like dampens author affinity vs a normal-surface like', async () => {
    const normalDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(normalDoc);
    await userPreferenceService.recordInteraction(VIEWER, videoPostId, 'like', { surface: 'for_you' });
    // The stored relationship `weight` (what ranking consumes) is the dampened
    // value — interactionCount is a side metric and is NOT surface-scaled.
    const normalAuthorWeight = normalDoc.preferredAuthors.find((a) => a.authorId === AUTHOR)
      ?.weight as number;

    const videoDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(videoDoc);
    await userPreferenceService.recordInteraction(VIEWER, videoPostId, 'like', { surface: 'videos' });
    const videoAuthorWeight = videoDoc.preferredAuthors.find((a) => a.authorId === AUTHOR)
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
    const normalDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(normalDoc);
    await userPreferenceService.recordInteraction(VIEWER, videoPostId, 'like', { surface: 'for_you' });
    const normalVideoTypePref = normalDoc.preferredPostTypes.video;

    const videoDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(videoDoc);
    await userPreferenceService.recordInteraction(VIEWER, videoPostId, 'like', { surface: 'videos' });
    const videoVideoTypePref = videoDoc.preferredPostTypes.video;

    expect(normalVideoTypePref).toBeGreaterThan(0);
    // It is the VIDEO bucket that moved, not some other post type.
    expect(normalDoc.preferredPostTypes.text).toBe(0);
    // Content (post-type) affinity is amplified on the video surface.
    expect(videoVideoTypePref).toBeCloseTo(
      normalVideoTypePref * MtnConfig.preferences.engagementContext.videoSurfaceContentBoost,
      5,
    );
    expect(videoVideoTypePref).toBeGreaterThan(normalVideoTypePref);
  });

  it('no context behaves exactly like a normal-surface like (backward compatible)', async () => {
    const ctxDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(ctxDoc);
    await userPreferenceService.recordInteraction(VIEWER, videoPostId, 'like', { surface: 'for_you' });
    const ctxWeight = ctxDoc.preferredAuthors.find((a) => a.authorId === AUTHOR)?.weight as number;

    const noCtxDoc = makeBehaviorDoc();
    mocks.behaviorFindOne.mockResolvedValueOnce(noCtxDoc);
    await userPreferenceService.recordInteraction(VIEWER, videoPostId, 'like');
    const noCtxWeight = noCtxDoc.preferredAuthors.find((a) => a.authorId === AUTHOR)?.weight as number;

    expect(noCtxWeight).toBeCloseTo(ctxWeight, 5);
  });
});
