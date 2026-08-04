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
 * The accumulators are real rows too. Each comparison needs two INDEPENDENT
 * viewers rather than two throwaway stub documents, which is closer to what the
 * two surfaces actually are: two people, one engaging from the feed and one from
 * the reels viewer.
 */

// Like/Bookmark are imported by the service but unused on the recordInteraction path.
vi.mock('../../models/Like', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  deleteUserBehavior,
  loadUserBehavior,
} from '../../db/userProfile/userBehaviorRepository';
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
/** One viewer per surface, so the two accumulators cannot contaminate each other. */
const NORMAL_VIEWER = scope.user('viewer-normal');
const VIDEO_VIEWER = scope.user('viewer-video');
const AUTHOR = scope.user('author');

/** The one video post every attribution case below engages with. */
let videoPostId: string;

/** The viewer's stored relationship weight for {@link AUTHOR}. */
async function authorWeight(viewer: string): Promise<number | undefined> {
  const behavior = await loadUserBehavior(viewer);
  return behavior?.preferredAuthors.find((a) => a.authorId === AUTHOR)?.weight;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  await deleteUserBehavior(NORMAL_VIEWER);
  await deleteUserBehavior(VIDEO_VIEWER);
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
  await deleteUserBehavior(NORMAL_VIEWER);
  await deleteUserBehavior(VIDEO_VIEWER);
});

afterAll(async () => {
  await closePostgres();
});

describe('UserPreferenceService surface-aware attribution', () => {
  it('a VIDEO-surface like dampens author affinity vs a normal-surface like', async () => {
    await userPreferenceService.recordInteraction(NORMAL_VIEWER, videoPostId, 'like', { surface: 'for_you' });
    // The stored relationship `weight` (what ranking consumes) is the dampened
    // value — interactionCount is a side metric and is NOT surface-scaled.
    const normalAuthorWeight = (await authorWeight(NORMAL_VIEWER)) as number;

    await userPreferenceService.recordInteraction(VIDEO_VIEWER, videoPostId, 'like', { surface: 'videos' });
    const videoAuthorWeight = (await authorWeight(VIDEO_VIEWER)) as number;

    expect(normalAuthorWeight).toBeGreaterThan(0);
    expect(videoAuthorWeight).toBeGreaterThan(0);
    // The reels like accrues the configured fraction of author affinity weight.
    expect(videoAuthorWeight).toBeCloseTo(
      normalAuthorWeight * MtnConfig.preferences.engagementContext.videoSurfaceAuthorAffinityFactor,
      5,
    );
  });

  it('a VIDEO-surface like amplifies post-type (content) affinity vs a normal-surface like', async () => {
    await userPreferenceService.recordInteraction(NORMAL_VIEWER, videoPostId, 'like', { surface: 'for_you' });
    const normalTypes = (await loadUserBehavior(NORMAL_VIEWER))?.preferredPostTypes;
    const normalVideoTypePref = normalTypes?.video as number;

    await userPreferenceService.recordInteraction(VIDEO_VIEWER, videoPostId, 'like', { surface: 'videos' });
    const videoVideoTypePref = (await loadUserBehavior(VIDEO_VIEWER))?.preferredPostTypes.video as number;

    expect(normalVideoTypePref).toBeGreaterThan(0);
    // It is the VIDEO bucket that moved, not some other post type.
    expect(normalTypes?.text).toBe(0);
    // Content (post-type) affinity is amplified on the video surface.
    expect(videoVideoTypePref).toBeCloseTo(
      normalVideoTypePref * MtnConfig.preferences.engagementContext.videoSurfaceContentBoost,
      5,
    );
    expect(videoVideoTypePref).toBeGreaterThan(normalVideoTypePref);
  });

  it('no context behaves exactly like a normal-surface like (backward compatible)', async () => {
    await userPreferenceService.recordInteraction(NORMAL_VIEWER, videoPostId, 'like', { surface: 'for_you' });
    const ctxWeight = (await authorWeight(NORMAL_VIEWER)) as number;

    // VIDEO_VIEWER is just a second, independent viewer here — this case passes
    // no surface at all, which is the path being compared.
    await userPreferenceService.recordInteraction(VIDEO_VIEWER, videoPostId, 'like');
    const noCtxWeight = (await authorWeight(VIDEO_VIEWER)) as number;

    expect(noCtxWeight).toBeCloseTo(ctxWeight, 5);
  });

  it('stores a FRACTIONAL author interaction count for a fractional learning weight', async () => {
    // `save` carries a learning weight of 1.5, and the author accumulator adds
    // that weight rather than a tally. `user_behavior_authors.interaction_count`
    // was `integer`, which postgres.js parameters cannot even be written to
    // ("invalid input syntax for type integer"), so this is the regression test
    // for the half of the widening migration the topic cases do not reach.
    await userPreferenceService.recordInteraction(NORMAL_VIEWER, videoPostId, 'save');

    const behavior = await loadUserBehavior(NORMAL_VIEWER);
    const pref = behavior?.preferredAuthors.find((a) => a.authorId === AUTHOR);
    expect(pref?.interactionCount).toBeCloseTo(1.5, 6);
  });
});
