import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * PHASE 7 — online feed-quality metrics + A/B bucketing.
 *
 * Covers the metric-emission helpers (labels + normalization), the deterministic
 * discovery-gate A/B bucketing, the `report` interaction event (schema + tracker
 * emission), and the impression/signal metrics emitted by the interaction tracker.
 * The tracker's heavy collaborators (Post read, view counter, dwell, preference
 * learning) are faked so the assertions isolate the metric side effects.
 */

vi.mock('../models/Post', () => ({
  Post: { findOne: vi.fn() },
}));
vi.mock('../services/feedViewCounter', () => ({
  recordDedupedView: vi.fn(async () => true),
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
import { Post } from '../models/Post';

const validPostId = new mongoose.Types.ObjectId().toString();

/** Point `Post.findOne(...).lean()` at a fixed lean doc (or null). */
function mockPostFindOne(doc: Record<string, unknown> | null): void {
  vi.mocked(Post.findOne).mockReturnValue({
    lean: async () => doc,
  } as unknown as ReturnType<typeof Post.findOne>);
}

beforeEach(() => {
  metrics.reset();
  vi.clearAllMocks();
});

describe('feedMetrics helpers', () => {
  it('normalizes free-form descriptors to their base feed type', () => {
    expect(baseDescriptor('for_you')).toBe('for_you');
    expect(baseDescriptor('author|507f1f77bcf86cd799439011')).toBe('author');
    expect(baseDescriptor('hashtag|cats')).toBe('hashtag');
    expect(baseDescriptor(undefined)).toBe('unknown');
    expect(baseDescriptor('')).toBe('unknown');
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
    const ok = new FeedInteraction({ userId: 'u', feedDescriptor: 'for_you', postUri: validPostId, event: 'report' });
    expect(ok.validateSync()).toBeUndefined();

    const bad = new FeedInteraction({ userId: 'u', feedDescriptor: 'for_you', postUri: validPostId, event: 'bogus' });
    const error = bad.validateSync();
    expect(error?.errors.event).toBeDefined();
  });
});

describe('recordReportSignal', () => {
  it('emits feed_report_total split by origin (federated)', async () => {
    mockPostFindOne({ federation: { actorUri: 'https://remote/users/x' } });
    await recordReportSignal({ userId: 'u', feedDescriptor: 'for_you', postUri: validPostId, event: 'report', timestamp: new Date() });
    expect(metrics.getCounter(FEED_METRICS.report, { descriptor: 'for_you', origin: 'federated' })).toBe(1);
  });

  it('counts a non-local uri as a local report without a DB read', async () => {
    await recordReportSignal({ userId: 'u', feedDescriptor: 'for_you', postUri: 'at://not-an-object-id', event: 'report', timestamp: new Date() });
    expect(Post.findOne).not.toHaveBeenCalled();
    expect(metrics.getCounter(FEED_METRICS.report, { descriptor: 'for_you', origin: 'local' })).toBe(1);
  });
});

describe('applyImpressionSignals metrics', () => {
  it('emits impression + signal metrics for a genuine federated impression (view)', async () => {
    mockPostFindOne({ oxyUserId: 'author-1', federation: { actorUri: 'https://remote/users/x' } });
    await applyImpressionSignals({ userId: 'viewer-1', feedDescriptor: 'for_you', postUri: validPostId, event: 'impression', durationMs: 5000, timestamp: new Date() });
    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'federated', descriptor: 'for_you' })).toBe(1);
    expect(metrics.getCounter(FEED_METRICS.interactionSignal, { signal: 'view', descriptor: 'for_you' })).toBe(1);
  });

  it('classifies a short dwell as a skip and a local post as local origin', async () => {
    mockPostFindOne({ oxyUserId: 'author-1' });
    await applyImpressionSignals({ userId: 'viewer-1', feedDescriptor: 'author|507f1f77bcf86cd799439011', postUri: validPostId, event: 'impression', durationMs: 300, timestamp: new Date() });
    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'author' })).toBe(1);
    expect(metrics.getCounter(FEED_METRICS.interactionSignal, { signal: 'skip', descriptor: 'author' })).toBe(1);
  });

  it('does NOT emit an impression for a viewer impressing their OWN post (self-pump guard)', async () => {
    mockPostFindOne({ oxyUserId: 'viewer-1', federation: { actorUri: 'x' } });
    await applyImpressionSignals({ userId: 'viewer-1', feedDescriptor: 'for_you', postUri: validPostId, event: 'impression', durationMs: 5000, timestamp: new Date() });
    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'federated', descriptor: 'for_you' })).toBe(0);
    expect(metrics.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'for_you' })).toBe(0);
  });
});
