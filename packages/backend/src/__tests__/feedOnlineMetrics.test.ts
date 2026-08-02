import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { PostVisibility } from '@mention/shared-types';

/**
 * PHASE 7 — online feed-quality metrics + A/B bucketing.
 *
 * Covers the metric-emission helpers (labels + normalization), the deterministic
 * discovery-gate A/B bucketing, the `report` interaction event, and the
 * impression/signal metrics the interaction tracker emits.
 *
 * ## The post lookup is a real query now, and that changed what is testable
 *
 * The tracker used to reach `Post.findOne(...).lean()`, which this file faked —
 * so "a federated post is labelled `federated`" was an assertion about the fake's
 * return value, and the untrusted-input guard ("resolve a real public, published
 * post before any side effect") could not be exercised at all. Both reads are
 * `posts` queries today, so every case below writes the post it is about.
 *
 * `IS_FEDERATED` in particular has to be checked against rows: it is a
 * six-column disjunction, and a federated post that arrived without an
 * `activity_id` being mislabelled `local` is invisible in any assertion about a
 * mock.
 *
 * The tracker's other collaborators (the Redis view counter, the dwell
 * aggregate, preference learning) stay faked — they are other modules' subjects
 * and none of them decides a metric label.
 */

vi.mock('../services/feedViewCounter', () => ({
  // A counted view resolves to the post's new total (null when it did not count).
  recordDedupedView: vi.fn(async () => 1),
}));
vi.mock('../services/dwellAggregate', () => ({
  recordDwell: vi.fn(async () => undefined),
}));
vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: { recordInteraction: vi.fn(async () => undefined) },
}));

import { metrics } from '../utils/metrics';
import {
  FEED_METRICS,
  baseDescriptor,
  originForFederation,
  recordDiscoveryGated,
  recordFederatedShare,
  recordImpression,
  recordInteractionSignal,
  recordReport,
} from '../mtn/feed/feedMetrics';
import {
  bucketForDiscoveryGate,
  resolveDiscoveryGateBucket,
  isDiscoveryGateExperimentEnabled,
} from '../mtn/feed/discoveryGateExperiment';
import { applyImpressionSignals, recordReportSignal } from '../mtn/feed/FeedInteractionTracker';
import { FeedInteraction } from '../models/FeedInteraction';
import { closePostgres, connectPostgres } from '../db/postgres';
import type { PostRecordInput } from '../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';

const scope = postScope('feed-online-metrics');
const AUTHOR = scope.user('author');
const VIEWER = scope.user('viewer');

/** A post by {@link AUTHOR}, public and published unless a case says otherwise. */
async function seedTrackedPost(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const owner = (overrides.oxyUserId ?? AUTHOR) as string;
  const record = await seedPost(scope, {
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
    ...overrides,
  });
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  metrics.reset();
  vi.clearAllMocks();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('feedMetrics helpers', () => {
  it('normalizes free-form descriptors to their base feed type', () => {
    expect(baseDescriptor('for_you')).toBe('for_you');
    expect(baseDescriptor('author|507f1f77bcf86cd799439011')).toBe('author');
    expect(baseDescriptor('hashtag|cats')).toBe('hashtag');
    expect(baseDescriptor(undefined)).toBe('unknown');
    expect(baseDescriptor('')).toBe('unknown');
    expect(baseDescriptor('attacker-controlled|value')).toBe('unknown');
  });

  it('derives origin from the presence of a federation subdoc', () => {
    expect(originForFederation({ actorUri: 'x' })).toBe('federated');
    expect(originForFederation(null)).toBe('local');
    expect(originForFederation(undefined)).toBe('local');
  });

  it('emits feed_discovery_gated_total with reason/source/shadow labels', () => {
    recordDiscoveryGated('lowEffortGate', 'trending', true);
    recordDiscoveryGated('nativeEngagement', 'globalDiscovery', false);
    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'lowEffortGate', source: 'trending', shadow: 'true' })).toBe(1);
    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'nativeEngagement', source: 'globalDiscovery', shadow: 'false' })).toBe(1);
  });

  it('emits feed_federated_share as a per-descriptor gauge', () => {
    recordFederatedShare('for_you', 0.42);
    recordFederatedShare('author|123', 0.9);
    expect(metrics.getGauge(FEED_METRICS.federatedShare, { descriptor: 'for_you' })).toBeCloseTo(0.42, 5);
    expect(metrics.getGauge(FEED_METRICS.federatedShare, { descriptor: 'author' })).toBeCloseTo(0.9, 5);
  });

  it('emits impression / interaction-signal / report counters with correct labels', () => {
    recordImpression('for_you', 'federated');
    recordInteractionSignal('skip', 'hashtag|cats');
    recordReport('for_you', 'local');
    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'federated', descriptor: 'for_you' })).toBe(1);
    expect(metrics.getCounter(FEED_METRICS.interactionSignal, { signal: 'skip', descriptor: 'hashtag' })).toBe(1);
    expect(metrics.getCounter(FEED_METRICS.report, { descriptor: 'for_you', origin: 'local' })).toBe(1);
  });
});

describe('discovery-gate A/B bucketing', () => {
  const original = process.env.FOR_YOU_DISCOVERY_GATE_AB;
  afterEach(() => {
    if (original === undefined) delete process.env.FOR_YOU_DISCOVERY_GATE_AB;
    else process.env.FOR_YOU_DISCOVERY_GATE_AB = original;
  });

  it('is deterministic and stable per user id', () => {
    const id = 'oxy-user-abc123';
    const a = bucketForDiscoveryGate(id);
    const b = bucketForDiscoveryGate(id);
    expect(a).toBe(b);
    expect(['gate-on', 'gate-off']).toContain(a);
  });

  it('assigns both buckets across a population (roughly balanced)', () => {
    let on = 0;
    for (let i = 0; i < 200; i += 1) {
      if (bucketForDiscoveryGate(`user-${i}`) === 'gate-on') on += 1;
    }
    // A SHA-256 parity split should be near 50/50 — assert it is not degenerate.
    expect(on).toBeGreaterThan(50);
    expect(on).toBeLessThan(150);
  });

  it('is gated by the env flag and requires a user id', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE_AB;
    expect(isDiscoveryGateExperimentEnabled()).toBe(false);
    expect(resolveDiscoveryGateBucket('u1')).toBeUndefined();

    process.env.FOR_YOU_DISCOVERY_GATE_AB = 'on';
    expect(isDiscoveryGateExperimentEnabled()).toBe(true);
    expect(resolveDiscoveryGateBucket(undefined)).toBeUndefined();
    expect(resolveDiscoveryGateBucket('u1')).toBe(bucketForDiscoveryGate('u1'));
  });
});

describe('FeedInteraction report event', () => {
  it('accepts the report event and rejects an unknown one', () => {
    const postUri = new mongoose.Types.ObjectId().toString();
    const ok = new FeedInteraction({ userId: 'u', feedDescriptor: 'for_you', postUri, event: 'report' });
    expect(ok.validateSync()).toBeUndefined();

    const bad = new FeedInteraction({ userId: 'u', feedDescriptor: 'for_you', postUri, event: 'bogus' });
    const error = bad.validateSync();
    expect(error?.errors.event).toBeDefined();
  });
});

describe('recordReportSignal', () => {
  it('labels a report on a federated post as federated', async () => {
    const postId = await seedTrackedPost({
      federation: { actorUri: `https://${scope.name}.test/users/x` },
    });

    await recordReportSignal({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: postId,
      event: 'report',
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.report, { descriptor: 'for_you', origin: 'federated' })).toBe(1);
  });

  it('labels a federated post carrying no activity id as federated', async () => {
    // `IS_FEDERATED` is a six-column disjunction precisely so an import that
    // arrived with only a spoiler text is not counted as one of ours. A single
    // -column test passes against a predicate that reads only `activity_id`.
    const postId = await seedTrackedPost({
      federation: { spoilerText: 'CW: politics' },
    });

    await recordReportSignal({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: postId,
      event: 'report',
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.report, { descriptor: 'for_you', origin: 'federated' })).toBe(1);
  });

  it('labels a report on a native post as local', async () => {
    const postId = await seedTrackedPost();

    await recordReportSignal({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: postId,
      event: 'report',
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.report, { descriptor: 'for_you', origin: 'local' })).toBe(1);
  });

  it('counts a uri that resolves to no post as a local report', async () => {
    // `postUri` is CLIENT-supplied. The ObjectId pre-check that used to skip the
    // read was removed on purpose — it would discard every post created since
    // the cutover — so an unresolvable uri now simply matches no row. It must
    // still be COUNTED: dropping the report silently would understate the
    // report-per-impression rate rather than mislabel it.
    await recordReportSignal({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: 'at://not-a-local-post-id',
      event: 'report',
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.report, { descriptor: 'for_you', origin: 'local' })).toBe(1);
  });
});

describe('applyImpressionSignals metrics', () => {
  it('emits impression + signal metrics for a genuine federated impression (view)', async () => {
    const postId = await seedTrackedPost({
      federation: { actorUri: `https://${scope.name}.test/users/x` },
    });

    await applyImpressionSignals({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: postId,
      event: 'impression',
      durationMs: 5000,
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'federated', descriptor: 'for_you' })).toBe(1);
    expect(metrics.getCounter(FEED_METRICS.interactionSignal, { signal: 'view', descriptor: 'for_you' })).toBe(1);
  });

  it('classifies a short dwell as a skip and a local post as local origin', async () => {
    const postId = await seedTrackedPost();

    await applyImpressionSignals({
      userId: VIEWER,
      feedDescriptor: `author|${AUTHOR}`,
      postUri: postId,
      event: 'impression',
      durationMs: 300,
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'author' })).toBe(1);
    expect(metrics.getCounter(FEED_METRICS.interactionSignal, { signal: 'skip', descriptor: 'author' })).toBe(1);
  });

  it('does NOT emit an impression for a viewer impressing their OWN post (self-pump guard)', async () => {
    const postId = await seedTrackedPost({
      oxyUserId: VIEWER,
      federation: { actorUri: `https://${scope.name}.test/users/x` },
    });

    await applyImpressionSignals({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: postId,
      event: 'impression',
      durationMs: 5000,
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'federated', descriptor: 'for_you' })).toBe(0);
    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'for_you' })).toBe(0);
  });

  it.each([
    ['private', { visibility: PostVisibility.PRIVATE }],
    ['followers-only', { visibility: PostVisibility.FOLLOWERS_ONLY }],
    ['an unpublished draft', { status: 'draft' as const }],
  ])('records nothing for an impression on %s post', async (_label, overrides) => {
    // Client telemetry is untrusted, so a forged impression on a post the client
    // could never legitimately have seen must move no ranking signal at all.
    const postId = await seedTrackedPost(overrides);

    await applyImpressionSignals({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: postId,
      event: 'impression',
      durationMs: 5000,
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'for_you' })).toBe(0);
    expect(metrics.getCounter(FEED_METRICS.interactionSignal, { signal: 'view', descriptor: 'for_you' })).toBe(0);
  });

  it('records nothing for a postUri that resolves to no post', async () => {
    await applyImpressionSignals({
      userId: VIEWER,
      feedDescriptor: 'for_you',
      postUri: 'at://not-a-local-post-id',
      event: 'impression',
      durationMs: 5000,
      timestamp: new Date(),
    });

    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'for_you' })).toBe(0);
  });
});
