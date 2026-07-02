import { describe, it, expect } from 'vitest';
import type { FeedPostSlice, HydratedPost } from '@mention/shared-types';
import { filterByLanguage } from '../mtn/feed/tuners/filterByLanguage';
import type { TunerContext } from '../mtn/feed/FeedTuner';

/**
 * `filterByLanguage` matches on the canonical `postClassification.languages`
 * array (surfaced via hydrated `metadata.languages`) with ANY-OVERLAP semantics:
 * a bilingual post passes as long as one of its languages is preferred, and a
 * post with no declared language passes through (permissive, never hard-excludes).
 */
const slice = (languages?: string[]): FeedPostSlice => ({
  _sliceKey: 'k',
  isIncompleteThread: false,
  items: [
    {
      post: { metadata: { languages } } as unknown as HydratedPost,
      isThreadParent: false,
      isThreadChild: false,
      isThreadLastChild: false,
    },
  ],
});

const ctx = (languages: string[]): TunerContext => ({ preferences: { languages } });

describe('filterByLanguage', () => {
  it('passes posts whose languages array overlaps the preference', () => {
    const out = filterByLanguage([slice(['es', 'en'])], ctx(['en']));
    expect(out).toHaveLength(1);
  });

  it('drops posts with no overlap', () => {
    const out = filterByLanguage([slice(['fr'])], ctx(['en'])); // no overlap
    expect(out).toHaveLength(0);
  });

  it('passes posts with no language set (permissive)', () => {
    const out = filterByLanguage([slice(undefined)], ctx(['en']));
    expect(out).toHaveLength(1);
  });

  it('passes everything when no language preference is set', () => {
    const out = filterByLanguage([slice(['fr'])], ctx([]));
    expect(out).toHaveLength(1);
  });
});
