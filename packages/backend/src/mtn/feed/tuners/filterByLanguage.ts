import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Filter slices to only include preferred languages.
 * If no language preferences set, passes through all slices.
 */
export function filterByLanguage(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  const langs = ctx.preferences.languages;
  if (!langs || langs.length === 0) return slices;

  const langSet = new Set(langs.map((l) => l.toLowerCase()));

  return slices.filter((slice) => {
    // Check the anchor post's language
    const anchorPost = slice.items[0]?.post;
    if (!anchorPost) return true;
    const postLang = (anchorPost.metadata as any)?.language?.toLowerCase();
    // Pass through posts with no language set
    if (!postLang) return true;
    return langSet.has(postLang);
  });
}
