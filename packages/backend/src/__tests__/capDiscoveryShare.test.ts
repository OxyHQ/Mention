import { describe, it, expect } from 'vitest';

import { capDiscoveryShare } from '../mtn/feed/capDiscoveryShare';

/**
 * Phase 5 — DISCOVERY-SHARE CAP.
 *
 * `capDiscoveryShare` bounds how much of a rendered For You page may come from
 * DISCOVERY lanes, guaranteeing a floor for TRUSTED (following / affinity /
 * lists) content. Its contract is IDENTICAL to `diversifyByAuthor`: it NEVER
 * drops a slice — discovery overflow is DEFERRED to the page tail so it still
 * emits (after the trusted floor, or via pagination).
 *
 * The function is generic over the slice type with an injectable `isDiscovery`
 * predicate, so it is unit-tested here against plain fixtures — exactly the shape
 * the engine runs it on (raw pre-hydration slices carrying the `_discovery`
 * marker), with no HydratedPost construction or casts.
 */

interface TestSlice {
  id: string;
  discovery: boolean;
}

const isDiscovery = (slice: TestSlice): boolean => slice.discovery;

function trusted(id: string): TestSlice {
  return { id, discovery: false };
}

function discovery(id: string): TestSlice {
  return { id, discovery: true };
}

function ids(slices: TestSlice[]): string[] {
  return slices.map((s) => s.id);
}

function discoveryCount(slices: TestSlice[]): number {
  return slices.filter((s) => s.discovery).length;
}

/** Assert the output is a permutation of the input (never drops, never invents). */
function expectSamePosts(output: TestSlice[], input: TestSlice[]): void {
  expect(output).toHaveLength(input.length);
  expect([...ids(output)].sort()).toEqual([...ids(input)].sort());
}

describe('capDiscoveryShare — no-op guards (returns the input unchanged)', () => {
  const page = [trusted('t1'), discovery('d1'), discovery('d2')];

  it('no cap configured (maxShare undefined)', () => {
    expect(capDiscoveryShare(page, isDiscovery, undefined, 30)).toBe(page);
  });

  it('a share that admits everything (>= 1)', () => {
    expect(capDiscoveryShare(page, isDiscovery, 1, 30)).toBe(page);
  });

  it('an empty page', () => {
    const empty: TestSlice[] = [];
    expect(capDiscoveryShare(empty, isDiscovery, 0.7, 30)).toBe(empty);
  });

  it('a non-positive limit', () => {
    expect(capDiscoveryShare(page, isDiscovery, 0.7, 0)).toBe(page);
  });

  it('a page with no discovery slices (all trusted)', () => {
    const allTrusted = [trusted('t1'), trusted('t2'), trusted('t3')];
    expect(capDiscoveryShare(allTrusted, isDiscovery, 0.7, 30)).toBe(allTrusted);
  });

  it('discovery already within the cap (nothing to defer)', () => {
    // limit 10, maxShare 0.7 → maxDiscovery 7; only 3 discovery slices → no overflow.
    const within = [
      trusted('t1'), discovery('d1'), trusted('t2'),
      discovery('d2'), trusted('t3'), discovery('d3'),
    ];
    expect(capDiscoveryShare(within, isDiscovery, 0.7, 10)).toBe(within);
  });
});

describe('capDiscoveryShare — deferral contract (never drops)', () => {
  it('defers discovery overflow to the tail without dropping anything', () => {
    // limit 10, maxShare 0.7 → maxDiscovery = floor(7) = 7.
    const input = [
      ...Array.from({ length: 8 }, (_, i) => discovery(`d${i}`)), // 8 discovery
      ...Array.from({ length: 4 }, (_, i) => trusted(`t${i}`)),   // 4 trusted
    ];
    const out = capDiscoveryShare(input, isDiscovery, 0.7, 10);

    // Never drops: output is a permutation of the input.
    expectSamePosts(out, input);

    // Exactly one discovery slice exceeded the cap of 7 → deferred to the tail.
    expect(out[out.length - 1]).toEqual(discovery('d7'));

    // The kept prefix holds every trusted slice + exactly maxDiscovery discovery.
    const kept = out.slice(0, out.length - 1);
    expect(discoveryCount(kept)).toBe(7);
    expect(kept.filter((s) => !s.discovery)).toHaveLength(4);
  });

  it('preserves relative order within kept and within deferred (stable partition)', () => {
    // limit 4, maxShare 0.5 → maxDiscovery = floor(2) = 2. 5 discovery, 2 trusted.
    const input = [
      discovery('d0'), trusted('t0'), discovery('d1'), discovery('d2'),
      trusted('t1'), discovery('d3'), discovery('d4'),
    ];
    const out = capDiscoveryShare(input, isDiscovery, 0.5, 4);

    expectSamePosts(out, input);
    // First 2 discovery (d0, d1) + both trusted stay; d2, d3, d4 defer in order.
    expect(ids(out)).toEqual(['d0', 't0', 'd1', 't1', 'd2', 'd3', 'd4']);
  });

  it('respects the trusted floor: trusted slices are never deferred', () => {
    // limit 10, maxShare 0.7 → maxDiscovery 7. 8 trusted + 8 discovery, interleaved.
    const input: TestSlice[] = [];
    for (let i = 0; i < 8; i += 1) {
      input.push(discovery(`d${i}`));
      input.push(trusted(`t${i}`));
    }
    const out = capDiscoveryShare(input, isDiscovery, 0.7, 10);

    expectSamePosts(out, input);

    // Every trusted slice appears before every DEFERRED discovery slice: the last
    // trusted index must precede the first deferred (overflow) discovery index.
    const lastTrustedIdx = out.reduce((acc, s, i) => (s.discovery ? acc : i), -1);
    // The single overflow slice is 'd7' (the 8th discovery, beyond the cap of 7).
    const overflowIdx = ids(out).indexOf('d7');
    expect(overflowIdx).toBeGreaterThan(lastTrustedIdx);

    // The rendered page (first `limit`) is cap-binding here (kept ≥ limit), so its
    // discovery share is at or under the cap and trusted keeps its floor.
    const window = out.slice(0, 10);
    expect(discoveryCount(window)).toBeLessThanOrEqual(7);
    expect(window.filter((s) => !s.discovery).length).toBeGreaterThanOrEqual(3);
  });
});

describe('capDiscoveryShare — thin follow graph still fills the page', () => {
  it('an all-discovery page fills to the limit (cap unmet → discovery backfills)', () => {
    // No trusted content at all: the cap defers overflow but never drops it, so the
    // deferred discovery backfills the tail and the page still reaches `limit`.
    const input = Array.from({ length: 12 }, (_, i) => discovery(`d${i}`));
    const out = capDiscoveryShare(input, isDiscovery, 0.7, 10);

    expectSamePosts(out, input);
    // The rendered page window still fills to the limit.
    expect(out.slice(0, 10)).toHaveLength(10);
  });

  it('a trusted-poor page still fills to the limit (deferred discovery backfills)', () => {
    // 2 trusted + 12 discovery, limit 10, maxDiscovery 7. kept = 2 + 7 = 9 < limit,
    // so one deferred discovery slice backfills the visible page — it fills to 10.
    const input = [
      trusted('t0'), trusted('t1'),
      ...Array.from({ length: 12 }, (_, i) => discovery(`d${i}`)),
    ];
    const out = capDiscoveryShare(input, isDiscovery, 0.7, 10);

    expectSamePosts(out, input);
    const window = out.slice(0, 10);
    expect(window).toHaveLength(10);
    // Both trusted slices survive inside the rendered page (trusted floor honored).
    expect(window.filter((s) => !s.discovery).map((s) => s.id).sort()).toEqual(['t0', 't1']);
  });
});
