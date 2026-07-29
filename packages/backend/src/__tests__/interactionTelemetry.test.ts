import { describe, it, expect } from 'vitest';
import { FEED_INTERACTION_BATCH_LIMIT } from '@mention/shared-types';
import type { FeedInteractionInput } from '@mention/shared-types';
import { parseFeedInteractionBatch } from '../mtn/feed/interactionTelemetry';

const VALID: FeedInteractionInput = {
  feedDescriptor: 'for_you',
  postUri: '6a36caab8456c08100cdfd97',
  event: 'impression',
  durationMs: 2500,
};

function batchOf(count: number): FeedInteractionInput[] {
  return Array.from({ length: count }, (_, i) => ({ ...VALID, postUri: `post-${i}` }));
}

describe('parseFeedInteractionBatch', () => {
  it('accepts a well-formed batch', () => {
    expect(parseFeedInteractionBatch({ interactions: [VALID] })).toEqual({
      ok: true,
      interactions: [VALID],
    });
  });

  it('accepts an interaction without durationMs', () => {
    const click: FeedInteractionInput = { feedDescriptor: 'for_you', postUri: 'p1', event: 'click' };
    expect(parseFeedInteractionBatch({ interactions: [click] })).toEqual({
      ok: true,
      interactions: [click],
    });
  });

  it('accepts every event name in the shared union', () => {
    for (const event of ['impression', 'click', 'like', 'reply', 'boost', 'save', 'report']) {
      expect(parseFeedInteractionBatch({ interactions: [{ ...VALID, event }] }).ok).toBe(true);
    }
  });

  it('accepts a full batch at the cap', () => {
    const parsed = parseFeedInteractionBatch({ interactions: batchOf(FEED_INTERACTION_BATCH_LIMIT) });
    expect(parsed.ok).toBe(true);
  });

  it('rejects a batch over the cap', () => {
    const parsed = parseFeedInteractionBatch({
      interactions: batchOf(FEED_INTERACTION_BATCH_LIMIT + 1),
    });
    expect(parsed).toEqual({
      ok: false,
      error: `interactions exceeds the ${FEED_INTERACTION_BATCH_LIMIT} per-request limit`,
    });
  });

  it('rejects a non-object body', () => {
    expect(parseFeedInteractionBatch(null).ok).toBe(false);
    expect(parseFeedInteractionBatch('interactions').ok).toBe(false);
    expect(parseFeedInteractionBatch(42).ok).toBe(false);
  });

  it('rejects a missing or non-array interactions field', () => {
    expect(parseFeedInteractionBatch({})).toEqual({ ok: false, error: 'Missing interactions array' });
    expect(parseFeedInteractionBatch({ interactions: VALID })).toEqual({
      ok: false,
      error: 'Missing interactions array',
    });
  });

  it('rejects an empty batch — a client bug, not a silent no-op', () => {
    expect(parseFeedInteractionBatch({ interactions: [] })).toEqual({
      ok: false,
      error: 'interactions must not be empty',
    });
  });

  it('rejects the pre-batch single-interaction body', () => {
    // The old wire shape. It must fail loudly rather than be silently accepted
    // as an empty batch, which would lose the signal with a 200.
    expect(parseFeedInteractionBatch(VALID).ok).toBe(false);
  });

  it('rejects an entry with a missing or blank feedDescriptor', () => {
    for (const feedDescriptor of [undefined, '', '   ', 7]) {
      expect(parseFeedInteractionBatch({ interactions: [{ ...VALID, feedDescriptor }] })).toEqual({
        ok: false,
        error: 'Invalid or missing feedDescriptor',
      });
    }
  });

  it('rejects an entry with a missing or blank postUri', () => {
    for (const postUri of [undefined, '', '   ', { $ne: null }]) {
      expect(parseFeedInteractionBatch({ interactions: [{ ...VALID, postUri }] })).toEqual({
        ok: false,
        error: 'Invalid or missing postUri',
      });
    }
  });

  it('rejects an unknown event', () => {
    expect(parseFeedInteractionBatch({ interactions: [{ ...VALID, event: 'follow' }] })).toEqual({
      ok: false,
      error: 'Invalid or missing event',
    });
  });

  it('rejects a non-numeric or negative durationMs', () => {
    for (const durationMs of ['2500', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseFeedInteractionBatch({ interactions: [{ ...VALID, durationMs }] })).toEqual({
        ok: false,
        error: 'Invalid durationMs',
      });
    }
  });

  it('fails the WHOLE batch on one bad entry, so a broken client is not silently degraded', () => {
    const parsed = parseFeedInteractionBatch({
      interactions: [VALID, { ...VALID, event: 'nope' }, VALID],
    });
    expect(parsed).toEqual({ ok: false, error: 'Invalid or missing event' });
  });

  it('strips fields the client had no business sending', () => {
    const parsed = parseFeedInteractionBatch({
      interactions: [{ ...VALID, userId: 'someone-else', timestamp: 'yesterday' }],
    });
    expect(parsed).toEqual({ ok: true, interactions: [VALID] });
  });
});
