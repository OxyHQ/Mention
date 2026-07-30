import { describe, it, expect } from 'vitest';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';

/**
 * The videos feed must not treat MISSING metadata as a failed match.
 *
 * Measured against production on 2026-07-30: 9,465 posts carry a video media
 * item; the shipped default query returned 147. `durationSec` is present on 5.9%
 * of them and on 0% of the last day's arrivals, because the entire video corpus
 * is federated (native video posts: 0), Mastodon advertises width/height but
 * essentially never duration, and `enrichFromOxy` cannot fill it in — federated
 * media is stored raw by `remoteUrl` and is not an Oxy asset.
 *
 * So a `$gte` on a mostly-absent field was not enforcing a 20-second policy; it
 * was discarding 94% of the corpus and enforcing the policy on the remainder.
 * These tests pin the two halves of the correction, both of which are the same
 * rule: unknown is not a value.
 */

function elemMatchOf(match: Record<string, unknown>): Record<string, unknown> {
  const and = match.$and as Array<Record<string, unknown>>;
  const media = and.find((clause) => 'content.media' in clause) as {
    'content.media': { $elemMatch: Record<string, unknown> };
  };
  return media['content.media'].$elemMatch;
}

describe('buildVideosQuery — duration is applied when known, never as an existence gate', () => {
  it('admits a video whose duration was never persisted', () => {
    const elem = elemMatchOf(FeedQueryBuilder.buildVideosQuery([], { minDurationSec: 20 }));
    const alternatives = elem.$or as Array<Record<string, unknown>>;

    expect(alternatives).toContainEqual({ durationSec: { $exists: false } });
  });

  it('still enforces the minimum on a video whose duration IS known', () => {
    const elem = elemMatchOf(FeedQueryBuilder.buildVideosQuery([], { minDurationSec: 20 }));
    const alternatives = elem.$or as Array<Record<string, unknown>>;

    expect(alternatives).toContainEqual({ durationSec: { $gte: 20 } });
  });

  it('never constrains durationSec at the top level of the elemMatch', () => {
    // The original bug: `durationSec: {$gte: n}` sitting directly on the elemMatch,
    // where a document without the field simply does not match.
    const elem = elemMatchOf(FeedQueryBuilder.buildVideosQuery([], { minDurationSec: 20 }));

    expect(elem.durationSec).toBeUndefined();
  });

  it('carries the configured minimum through, not a hardcoded one', () => {
    const elem = elemMatchOf(FeedQueryBuilder.buildVideosQuery([], { minDurationSec: 7 }));
    const alternatives = elem.$or as Array<Record<string, unknown>>;

    expect(alternatives).toContainEqual({ durationSec: { $gte: 7 } });
  });
});

describe("buildVideosQuery — orientation 'all' means no orientation filter", () => {
  it("emits no orientation clause at all for 'all'", () => {
    const elem = elemMatchOf(FeedQueryBuilder.buildVideosQuery([], { orientation: 'all' }));

    // Not `{$exists: true}` — that is still a filter, and it is the one setting
    // whose name promises there is none.
    expect(elem.orientation).toBeUndefined();
  });

  it.each(['portrait', 'landscape', 'square'] as const)('still filters on %s', (orientation) => {
    const elem = elemMatchOf(FeedQueryBuilder.buildVideosQuery([], { orientation }));

    expect(elem.orientation).toBe(orientation);
  });

  it('keeps requiring real dimensions, which the player needs for layout', () => {
    const elem = elemMatchOf(FeedQueryBuilder.buildVideosQuery([], { orientation: 'all' }));

    expect(elem.width).toEqual({ $gt: 0 });
    expect(elem.height).toEqual({ $gt: 0 });
  });
});
