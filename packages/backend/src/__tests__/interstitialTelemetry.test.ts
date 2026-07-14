import { describe, it, expect, beforeEach } from 'vitest';
import type { FeedInterstitialEventInput } from '@mention/shared-types';
import {
  INTERSTITIAL_EVENT_METRIC,
  parseInterstitialEvent,
  recordInterstitialEvent,
} from '../mtn/feed/interstitials/interstitialTelemetry';
import { metrics } from '../utils/metrics';

const VALID_BODY: FeedInterstitialEventInput = {
  feedDescriptor: 'for_you',
  slotKey: 'int:suggestedUsers:slice-8',
  kind: 'suggestedUsers',
  event: 'follow',
};

describe('parseInterstitialEvent', () => {
  it('accepts a well-formed event', () => {
    const parsed = parseInterstitialEvent(VALID_BODY);
    expect(parsed).toEqual({ ok: true, input: VALID_BODY });
  });

  it('accepts an event carrying a position', () => {
    const parsed = parseInterstitialEvent({ ...VALID_BODY, position: 2 });
    expect(parsed).toEqual({ ok: true, input: { ...VALID_BODY, position: 2 } });
  });

  it('accepts every card kind and every event name', () => {
    const kinds = ['suggestedUsers', 'suggestedFeeds', 'suggestedStarterPacks', 'similarAccounts'];
    const events = ['impression', 'click', 'follow', 'subscribe', 'use', 'dismiss', 'seeMore'];

    for (const kind of kinds) {
      for (const event of events) {
        expect(parseInterstitialEvent({ ...VALID_BODY, kind, event }).ok).toBe(true);
      }
    }
  });

  it('accepts the profile card on an author descriptor', () => {
    const parsed = parseInterstitialEvent({
      feedDescriptor: 'author|user-1',
      slotKey: 'int:similarAccounts:slice-5',
      kind: 'similarAccounts',
      event: 'impression',
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects an unknown kind', () => {
    const parsed = parseInterstitialEvent({ ...VALID_BODY, kind: 'suggestedAliens' });
    expect(parsed).toEqual({ ok: false, error: 'Invalid or missing kind' });
  });

  it('rejects an unknown event', () => {
    const parsed = parseInterstitialEvent({ ...VALID_BODY, event: 'purchase' });
    expect(parsed).toEqual({ ok: false, error: 'Invalid or missing event' });
  });

  it('rejects a descriptor that is not a real feed — it becomes a metric label', () => {
    for (const feedDescriptor of ['', 'not_a_feed', 'for_you; DROP', 'random-junk|x']) {
      expect(parseInterstitialEvent({ ...VALID_BODY, feedDescriptor }).ok).toBe(false);
    }
  });

  it('rejects non-string fields rather than coercing them', () => {
    // Express (qs) and a hand-rolled client can both put anything in a JSON body:
    // arrays, objects, numbers. Nothing is stringified into a plausible value.
    const tampered: unknown[] = [
      { ...VALID_BODY, feedDescriptor: ['for_you'] },
      { ...VALID_BODY, kind: ['suggestedUsers'] },
      { ...VALID_BODY, event: { toString: 'follow' } },
      { ...VALID_BODY, slotKey: 42 },
      { ...VALID_BODY, slotKey: '   ' },
    ];

    for (const body of tampered) {
      expect(parseInterstitialEvent(body).ok).toBe(false);
    }
  });

  it('rejects a missing field', () => {
    for (const field of ['feedDescriptor', 'slotKey', 'kind', 'event'] as const) {
      const body: Record<string, unknown> = { ...VALID_BODY };
      delete body[field];
      expect(parseInterstitialEvent(body).ok).toBe(false);
    }
  });

  it('rejects a position that is not a non-negative integer', () => {
    for (const position of [-1, 1.5, Number.NaN, '2', null]) {
      expect(parseInterstitialEvent({ ...VALID_BODY, position }).ok).toBe(false);
    }
  });

  it('rejects a body that is not an object', () => {
    for (const body of [undefined, null, 'follow', 7, []]) {
      const parsed = parseInterstitialEvent(body);
      // An array IS an object, so it fails on its (absent) fields instead.
      expect(parsed.ok).toBe(false);
    }
  });
});

describe('recordInterstitialEvent', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('counts the event under low-cardinality labels only', () => {
    recordInterstitialEvent(VALID_BODY);
    recordInterstitialEvent(VALID_BODY);

    expect(
      metrics.getCounter(INTERSTITIAL_EVENT_METRIC, {
        kind: 'suggestedUsers',
        event: 'follow',
        descriptor: 'for_you',
      }),
    ).toBe(2);
  });

  it('labels by the BASE descriptor, never the parameterized one', () => {
    recordInterstitialEvent({
      feedDescriptor: 'author|user-1',
      slotKey: 'int:similarAccounts:slice-5',
      kind: 'similarAccounts',
      event: 'follow',
      position: 3,
    });
    recordInterstitialEvent({
      feedDescriptor: 'author|user-2|media',
      slotKey: 'int:similarAccounts:slice-5',
      kind: 'similarAccounts',
      event: 'follow',
      position: 1,
    });

    // Both profiles collapse onto the single `author` label — a per-profile (or
    // per-slot, or per-position) label would make the metric unbounded.
    expect(
      metrics.getCounter(INTERSTITIAL_EVENT_METRIC, {
        kind: 'similarAccounts',
        event: 'follow',
        descriptor: 'author',
      }),
    ).toBe(2);

    const emitted = Object.keys(metrics.getMetricsSummary().counters);
    expect(emitted).toEqual([INTERSTITIAL_EVENT_METRIC]);
  });

  it('emits nothing that identifies the viewer, the slot or the target', () => {
    recordInterstitialEvent({ ...VALID_BODY, slotKey: 'int:suggestedUsers:slice-8', position: 4 });

    const exported = metrics.getPrometheusFormat();
    expect(exported).toContain(INTERSTITIAL_EVENT_METRIC);
    expect(exported).not.toContain('slice-8');
    expect(exported).not.toContain('position');
  });
});
