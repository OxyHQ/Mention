import { describe, it, expect, beforeEach } from 'vitest';
import type { TrendEventInput } from '@mention/shared-types';
import {
  TREND_EVENT_METRIC,
  mintTrendRecId,
  parseTrendEvent,
  recordTrendEvent,
  resolveTrendFreshness,
} from '../services/trending/trendTelemetry';
import { metrics } from '../utils/metrics';

const VALID_BODY: TrendEventInput = {
  event: 'click',
  type: 'hashtag',
  surface: 'widget',
};

/** base36 of a millisecond timestamp — what `GET /trending` hands the client. */
const CURRENT_REC_ID = mintTrendRecId(new Date('2026-07-29T10:00:00.000Z'));
const PREVIOUS_REC_ID = mintTrendRecId(new Date('2026-07-29T09:30:00.000Z'));

describe('mintTrendRecId', () => {
  it('is deterministic for a batch and distinct across batches', () => {
    const batch = new Date('2026-07-29T10:00:00.000Z');
    expect(mintTrendRecId(batch)).toBe(mintTrendRecId(new Date(batch.getTime())));
    expect(CURRENT_REC_ID).not.toBe(PREVIOUS_REC_ID);
  });

  it('produces a token the parser accepts', () => {
    // The mint and the validator must agree, or every real client is a 400.
    expect(parseTrendEvent({ ...VALID_BODY, recId: CURRENT_REC_ID }).ok).toBe(true);
  });
});

describe('parseTrendEvent', () => {
  it('accepts a well-formed event', () => {
    expect(parseTrendEvent(VALID_BODY)).toEqual({ ok: true, input: VALID_BODY });
  });

  it('accepts an event carrying a rank and a recId', () => {
    const body = { ...VALID_BODY, rank: 3, recId: CURRENT_REC_ID };
    expect(parseTrendEvent(body)).toEqual({ ok: true, input: body });
  });

  it('accepts every type, event and surface', () => {
    const types = ['hashtag', 'topic', 'entity'];
    const events = ['click', 'seen'];
    const surfaces = ['widget', 'explore', 'search', 'interstitial', 'history'];

    for (const type of types) {
      for (const event of events) {
        for (const surface of surfaces) {
          expect(parseTrendEvent({ type, event, surface }).ok).toBe(true);
        }
      }
    }
  });

  it('rejects an unknown surface', () => {
    for (const surface of ['sidebar', 'SEARCH', '', 'widget ', 'profile']) {
      expect(parseTrendEvent({ ...VALID_BODY, surface })).toEqual({
        ok: false,
        error: 'Invalid or missing surface',
      });
    }
  });

  it('rejects an unknown event and an unknown type', () => {
    expect(parseTrendEvent({ ...VALID_BODY, event: 'purchase' }).ok).toBe(false);
    expect(parseTrendEvent({ ...VALID_BODY, type: 'starter-pack' }).ok).toBe(false);
  });

  it('rejects an over-long or non-alphanumeric recId', () => {
    // The token is client-supplied. It is never labelled, but it must not be a
    // channel for arbitrary content either.
    const tampered = [
      'm3rkq9x2b7c1f', // 13 chars — one over the bound
      'MRKQ9X2B', // uppercase
      'mrkq-9x2b', // punctuation
      'mrkq 9x2b', // whitespace
      '', // empty
      'a'.repeat(2000),
    ];

    for (const recId of tampered) {
      expect(parseTrendEvent({ ...VALID_BODY, recId })).toEqual({
        ok: false,
        error: 'Invalid recId',
      });
    }
  });

  it('rejects a rank that is not a positive integer', () => {
    for (const rank of [0, -1, 1.5, Number.NaN, '2', null]) {
      expect(parseTrendEvent({ ...VALID_BODY, rank })).toEqual({
        ok: false,
        error: 'Invalid rank',
      });
    }
  });

  it('rejects non-string fields rather than coercing them', () => {
    const tampered: unknown[] = [
      { ...VALID_BODY, type: ['hashtag'] },
      { ...VALID_BODY, event: { toString: 'click' } },
      { ...VALID_BODY, surface: 7 },
      { ...VALID_BODY, recId: 12345 },
    ];

    for (const body of tampered) {
      expect(parseTrendEvent(body).ok).toBe(false);
    }
  });

  it('rejects a missing field and a non-object body', () => {
    for (const field of ['event', 'type', 'surface'] as const) {
      const body: Record<string, unknown> = { ...VALID_BODY };
      delete body[field];
      expect(parseTrendEvent(body).ok).toBe(false);
    }

    for (const body of [undefined, null, 'click', 7, []]) {
      expect(parseTrendEvent(body).ok).toBe(false);
    }
  });
});

describe('resolveTrendFreshness', () => {
  it('reads a matching token as fresh and a rotated one as stale', () => {
    expect(resolveTrendFreshness(CURRENT_REC_ID, CURRENT_REC_ID)).toBe('fresh');
    expect(resolveTrendFreshness(PREVIOUS_REC_ID, CURRENT_REC_ID)).toBe('stale');
  });

  it('reads a missing token on either side as unknown, never as stale', () => {
    // A client that sent nothing (history row, older build) and a server that
    // could not resolve the current batch are both "we do not know" — folding
    // either into `stale` would invent a CDN-staleness signal that is not there.
    expect(resolveTrendFreshness(undefined, CURRENT_REC_ID)).toBe('unknown');
    expect(resolveTrendFreshness(CURRENT_REC_ID, null)).toBe('unknown');
    expect(resolveTrendFreshness(undefined, null)).toBe('unknown');
  });
});

describe('recordTrendEvent', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('counts the event under low-cardinality labels only', () => {
    recordTrendEvent(VALID_BODY, CURRENT_REC_ID);
    recordTrendEvent(VALID_BODY, CURRENT_REC_ID);

    expect(
      metrics.getCounter(TREND_EVENT_METRIC, {
        type: 'hashtag',
        event: 'click',
        surface: 'widget',
        freshness: 'unknown',
      }),
    ).toBe(2);
  });

  it('collapses the batch token into the bounded freshness label', () => {
    recordTrendEvent({ ...VALID_BODY, recId: CURRENT_REC_ID }, CURRENT_REC_ID);
    recordTrendEvent({ ...VALID_BODY, recId: PREVIOUS_REC_ID }, CURRENT_REC_ID);

    expect(
      metrics.getCounter(TREND_EVENT_METRIC, {
        type: 'hashtag',
        event: 'click',
        surface: 'widget',
        freshness: 'fresh',
      }),
    ).toBe(1);
    expect(
      metrics.getCounter(TREND_EVENT_METRIC, {
        type: 'hashtag',
        event: 'click',
        surface: 'widget',
        freshness: 'stale',
      }),
    ).toBe(1);
  });

  it('never emits the recId or the rank as a label', async () => {
    recordTrendEvent(
      { ...VALID_BODY, surface: 'interstitial', rank: 4, recId: CURRENT_REC_ID },
      CURRENT_REC_ID,
    );

    const exported = await metrics.getPrometheusFormat();
    expect(exported).toContain(TREND_EVENT_METRIC);
    // The token is high-cardinality by construction AND attacker-supplied; the
    // rank is per-position. Neither may reach the label space.
    expect(exported).not.toContain(CURRENT_REC_ID);
    expect(exported).not.toContain('recId=');
    expect(exported).not.toContain('rank=');

    // Positive control: the labels that ARE emitted, so this test cannot pass
    // by exporting nothing at all.
    expect(exported).toContain('surface="interstitial"');
    expect(exported).toContain('freshness="fresh"');
  });
});
