import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Filter slices to preferred languages using the canonical
 * `postClassification.languages` array (surfaced via hydrated metadata).
 * Any-overlap match; posts with no declared language pass through.
 */
export function filterByLanguage(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  const langs = ctx.preferences.languages;
  if (!langs || langs.length === 0) return slices;

  const langSet = new Set(langs.map((l) => l.toLowerCase()));

  return slices.filter((slice) => {
    const anchorPost = slice.items[0]?.post;
    if (!anchorPost) return true;
    const postLangs = anchorPost.metadata?.languages;
    // Pass through posts with no language set.
    if (!postLangs || postLangs.length === 0) return true;
    return postLangs.some((l) => langSet.has(l.toLowerCase()));
  });
}
