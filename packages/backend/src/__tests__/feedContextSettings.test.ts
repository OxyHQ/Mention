import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The viewer's own feed settings have to REACH the ranker.
 *
 * `UserSettings.feedSettings` is a fully built feature: `/settings/feed` writes
 * it, `routes/profileSettings.ts` validates and clamps every knob, the repository
 * stores it in eight columns, `FeedRankingSettings` types it, and
 * `FeedRankingService` reads `context.feedSettings` for the recency half-life,
 * the max age and the diversity penalties.
 *
 * Every part of that worked except the one that connected them:
 * `loadViewerFeedContext` never put the document on the context. So
 * `ctx.feedSettings` was `undefined` on every request in production, ranking fell
 * through to the `MtnConfig.ranking` defaults, and a viewer who lengthened their
 * recency half-life or switched diversity off changed nothing at all about their
 * feed. Nothing failed — the feature was simply inert.
 *
 * A shape assertion could not have caught that, and neither could the ranking
 * tests, which pass `feedSettings` in by hand. The gap was in the ASSEMBLY, so
 * this suite asserts on what `loadViewerFeedContext` returns after a real write
 * through the real repository.
 */

import { closePostgres, connectPostgres } from '../db/postgres';
import { loadViewerFeedContext } from '../mtn/feed/feedContext';
import { updateUserSettings } from '../db/userProfile/userSettingsRepository';
import { serviceScope } from './helpers/serviceFixtures';

const scope = serviceScope('feed-context-settings');
const VIEWER = scope.user('viewer');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  await updateUserSettings(VIEWER, {
    unset: {
      'feedSettings.recency.halfLifeHours': true,
      'feedSettings.diversity.enabled': true,
      'feedSettings.diversity.sameAuthorPenalty': true,
    },
  });
});

afterAll(async () => {
  await closePostgres();
});

describe('loadViewerFeedContext — the viewer feed settings reach the context', () => {
  it('carries a stored recency half-life through to ctx.feedSettings', async () => {
    await updateUserSettings(VIEWER, { set: { 'feedSettings.recency.halfLifeHours': 48 } });

    const ctx = await loadViewerFeedContext(VIEWER, undefined);

    expect(ctx.feedSettings?.recency?.halfLifeHours).toBe(48);
  });

  it('carries stored diversity knobs through to ctx.feedSettings', async () => {
    await updateUserSettings(VIEWER, {
      set: {
        'feedSettings.diversity.enabled': false,
        'feedSettings.diversity.sameAuthorPenalty': 0.6,
      },
    });

    const ctx = await loadViewerFeedContext(VIEWER, undefined);

    expect(ctx.feedSettings?.diversity?.enabled).toBe(false);
    expect(ctx.feedSettings?.diversity?.sameAuthorPenalty).toBe(0.6);
  });

  /**
   * The stored value has to be DISTINGUISHABLE from the default, or this suite
   * would pass against a context that still ignores the document and happens to
   * agree with `MtnConfig`. 48 hours is deliberately not the 24-hour default.
   */
  it('does not merely echo the config default', async () => {
    const { MtnConfig } = await import('@mention/shared-types');
    await updateUserSettings(VIEWER, { set: { 'feedSettings.recency.halfLifeHours': 48 } });

    const ctx = await loadViewerFeedContext(VIEWER, undefined);

    expect(ctx.feedSettings?.recency?.halfLifeHours).not.toBe(
      MtnConfig.ranking.recency.halfLifeHours,
    );
  });

  it('is undefined for an anonymous viewer, so ranking keeps its defaults', async () => {
    const ctx = await loadViewerFeedContext(undefined, undefined);

    expect(ctx.feedSettings).toBeUndefined();
  });
});
