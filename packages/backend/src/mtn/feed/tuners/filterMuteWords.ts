import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Filter posts containing muted words/phrases.
 */
export function filterMuteWords(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  const muteWords = ctx.preferences.muteWords;
  if (!muteWords || muteWords.length === 0) return slices;

  // Pre-compile regexes
  const contentPatterns = muteWords
    .filter((mw) => mw.targets.includes('content'))
    .map((mw) => new RegExp(`\\b${mw.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));

  const tagValues = new Set(
    muteWords
      .filter((mw) => mw.targets.includes('tag'))
      .map((mw) => mw.value.toLowerCase())
  );

  if (contentPatterns.length === 0 && tagValues.size === 0) return slices;

  return slices.filter((slice) => {
    const anchorPost = slice.items[0]?.post;
    if (!anchorPost) return true;

    // Check text content
    const text = anchorPost.content?.text || '';
    if (contentPatterns.some((re) => re.test(text))) return false;

    // Check hashtags
    const hashtags: string[] = (anchorPost.metadata as any)?.hashtags || [];
    if (hashtags.some((tag) => tagValues.has(tag.toLowerCase()))) return false;

    return true;
  });
}
