import {
  resolveInterstitialLimits,
  selectInterstitialWindow,
  shouldRenderInterstitial,
} from '../interstitialLayout';

/**
 * The two pure decisions behind every recommendation band: WHICH suggestions it
 * shows (`selectInterstitialWindow`) and WHETHER it shows at all
 * (`shouldRenderInterstitial`). Both are shared verbatim by the three kinds, so
 * proving them here proves the behavior for users, feeds and starter packs.
 */

interface Suggestion {
  id: string;
}

const idOf = (item: Suggestion) => item.id;
const none: ReadonlySet<string> = new Set();

/** `count` suggestions, ids `s0`, `s1`, … */
function pool(count: number): Suggestion[] {
  return Array.from({ length: count }, (_, index) => ({ id: `s${index}` }));
}

describe('shouldRenderInterstitial', () => {
  const desktop = resolveInterstitialLimits('suggestedUsers', true);
  const mobile = resolveInterstitialLimits('suggestedUsers', false);

  it('renders nothing when the suggestions come back empty', () => {
    expect(shouldRenderInterstitial(0, false, desktop)).toBe(false);
    expect(shouldRenderInterstitial(0, false, mobile)).toBe(false);
  });

  it('renders nothing below the minimum of 4 — the same on every screen, since both are a carousel', () => {
    expect(desktop.minItems).toBe(4);
    expect(mobile.minItems).toBe(4);

    for (const limits of [desktop, mobile]) {
      expect(shouldRenderInterstitial(3, false, limits)).toBe(false);
      expect(shouldRenderInterstitial(4, false, limits)).toBe(true);
    }
  });

  it('only the placeholder count depends on the screen — a wide column shows more of the row', () => {
    expect(desktop.maxItems).toBe(mobile.maxItems);
    expect(desktop.skeletonItems).toBe(4);
    expect(mobile.skeletonItems).toBe(2);
  });

  it('holds the band open on placeholders while the suggestions load', () => {
    expect(shouldRenderInterstitial(0, true, desktop)).toBe(true);
  });

  it('applies the same gate to every kind', () => {
    for (const kind of ['suggestedUsers', 'suggestedFeeds', 'suggestedStarterPacks'] as const) {
      expect(shouldRenderInterstitial(0, false, resolveInterstitialLimits(kind, true))).toBe(false);
      expect(shouldRenderInterstitial(0, false, resolveInterstitialLimits(kind, false))).toBe(false);
    }
  });
});

describe('selectInterstitialWindow', () => {
  const limits = resolveInterstitialLimits('suggestedUsers', true); // max 8, min 4

  it('returns an empty window for an empty pool', () => {
    expect(selectInterstitialWindow<Suggestion>([], 0, limits, idOf, none)).toEqual([]);
  });

  it('caps the first band at maxItems', () => {
    const window = selectInterstitialWindow(pool(20), 0, limits, idOf, none);
    expect(window.map(idOf)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
  });

  it('offsets each band by its ordinal so consecutive bands never repeat', () => {
    const first = selectInterstitialWindow(pool(20), 0, limits, idOf, none);
    const second = selectInterstitialWindow(pool(20), 1, limits, idOf, none);

    expect(second.map(idOf)).toEqual(['s8', 's9', 's10', 's11', 's12', 's13', 's14', 's15']);
    expect(first.map(idOf).some((id) => second.map(idOf).includes(id))).toBe(false);
  });

  it('backfills a dismissal from further down the pool instead of shrinking', () => {
    const dismissed = new Set(['s1', 's3']);
    const window = selectInterstitialWindow(pool(20), 0, limits, idOf, dismissed);

    expect(window).toHaveLength(limits.maxItems);
    expect(window.map(idOf)).toEqual(['s0', 's2', 's4', 's5', 's6', 's7', 's8', 's9']);
  });

  it('runs the band dry — and therefore closes it — when the pool is exhausted', () => {
    // Nine suggestions, eight consumed by the first band: the second has one
    // left, which is below the minimum, so the gate closes the band.
    const window = selectInterstitialWindow(pool(9), 1, limits, idOf, none);

    expect(window.map(idOf)).toEqual(['s8']);
    expect(shouldRenderInterstitial(window.length, false, limits)).toBe(false);
  });

  it('closes the band once dismissals drain the remaining pool below the minimum', () => {
    const dismissed = new Set(['s0', 's2']);
    const window = selectInterstitialWindow(pool(5), 0, limits, idOf, dismissed);

    expect(window.map(idOf)).toEqual(['s1', 's3', 's4']);
    expect(shouldRenderInterstitial(window.length, false, limits)).toBe(false);
  });
});
