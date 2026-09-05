/**
 * `personalization` signal — matches the post against the viewer's learned
 * preferences: preferred topics (hashtags + classified topic ids), preferred
 * post types, and preferred languages. Neutral (1.0) with no behavior data.
 */

import { getBaseLanguage } from '@oxyhq/core';
import { MtnConfig } from '@mention/shared-types';
import type {
  BehaviorSets,
  RankablePost,
  RankingUserBehavior,
  SignalContext,
} from '../signalContext';
import { getCanonicalTopics } from './classification';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * Calculate personalization score based on user preferences.
 */
export function personalizationScore(
  post: RankablePost,
  userBehavior: RankingUserBehavior | undefined,
  behaviorSets?: BehaviorSets,
  viewerBaseLanguages: readonly string[] = [],
): number {
  if (!userBehavior) {
    return 1.0;
  }

  let score = 1.0;

  // Topic matching (hashtags + AI-extracted topics)
  if (userBehavior.preferredTopics) {
    let matchCount = 0;

    // Match via hashtags (existing behavior)
    if (post.hashtags && post.hashtags.length > 0) {
      const preferredTopics = userBehavior.preferredTopics ?? [];
      matchCount += post.hashtags.filter((tag: string) =>
        preferredTopics.some((t) =>
          t.topic.toLowerCase() === tag.toLowerCase() && t.weight > 0.3
        )
      ).length;
    }

    // Match via classified topic IDs (richer signal). Prefer the canonical
    // `postClassification.topicRefs`, falling back to `postClassification.topics`.
    const prefTopicIds = behaviorSets?.preferredTopicIds;
    if (prefTopicIds && prefTopicIds.size > 0) {
      matchCount += getCanonicalTopics(post).filter(
        (t) => Boolean(t.topicId) && prefTopicIds.has(String(t.topicId)),
      ).length;
    }

    if (matchCount > 0) {
      score *= 1 + (matchCount * 0.1) * R.personalization.topicMatch;
    }
  }

  // Post type preference
  if (userBehavior.preferredPostTypes) {
    const postType = post.type?.toLowerCase() || 'text';
    const typeCount: number = (userBehavior.preferredPostTypes[postType as keyof typeof userBehavior.preferredPostTypes] as number) || 0;
    const totalTypes: number = Object.values(userBehavior.preferredPostTypes).reduce(
      (a: number, b: unknown) => a + (typeof b === 'number' ? b : 0), 0
    ) as number;

    if (totalTypes > 0 && typeCount > 0) {
      const typePreference = typeCount / totalTypes;
      if (typePreference > 0.3) { // User prefers this type
        score *= R.personalization.postTypeMatch;
      }
    }
  }

  // Language preference: boost when ANY of the post's classification languages is
  // one of the READER'S DECLARED languages (`ctx.viewerBaseLanguages`, already ISO
  // 639-1 base subtags). `postClassification.languages` is the single canonical
  // (multi-language) field; an unclassified post simply gets NO language boost
  // (neutral) until the backfill populates it.
  //
  // The input used to be the LEARNED `userBehavior.preferredLanguages`, and that
  // was the wrong side of a feedback loop: the array was appended to on any
  // recorded interaction — including a SKIP — never weighted and never decayed, so
  // scrolling past a German post taught this signal to boost German posts, which
  // put more of them in front of the reader to scroll past. Declared languages
  // cannot drift that way.
  if (viewerBaseLanguages.length > 0) {
    const postLanguages = post.postClassification?.languages;
    if (
      Array.isArray(postLanguages) &&
      postLanguages.some((lang) => viewerBaseLanguages.includes(getBaseLanguage(lang)))
    ) {
      score *= R.personalization.languageMatch;
    }
  }

  return Math.min(score, 2.0); // Cap at 2x boost
}

export const personalizationSignal: RankingSignal = {
  id: 'personalization',
  group: 'personalization',
  score: (post: RankablePost, ctx: SignalContext) =>
    personalizationScore(post, ctx.userBehavior, ctx.behaviorSets, ctx.viewerBaseLanguages),
};
