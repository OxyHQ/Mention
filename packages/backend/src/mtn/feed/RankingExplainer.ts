/**
 * RankingExplainer
 *
 * Attaches human-readable explanation to scored posts.
 * Useful for debugging feed quality and future "why am I seeing this?" UI.
 */

export interface RankingFactors {
  engagement: number;
  recency: number;
  relationship: number;
  personalization: number;
  quality: number;
  diversity: number;
  finalScore: number;
}

export interface RankingExplanation {
  factors: RankingFactors;
  topReason: string;
}

/**
 * Build an explanation from the ranking factors on a scored post.
 */
export function explainRanking(post: any): RankingExplanation {
  const factors: RankingFactors = {
    engagement: post._rankEngagement ?? 0,
    recency: post._rankRecency ?? 0,
    relationship: post._rankRelationship ?? 0,
    personalization: post._rankPersonalization ?? 0,
    quality: post._rankQuality ?? 0,
    diversity: post._rankDiversity ?? 0,
    finalScore: post.finalScore ?? 0,
  };

  // Determine top contributing factor
  const entries = Object.entries(factors).filter(([k]) => k !== 'finalScore');
  entries.sort((a, b) => b[1] - a[1]);
  const topFactor = entries[0]?.[0] ?? 'unknown';

  const reasonMap: Record<string, string> = {
    engagement: 'High engagement',
    recency: 'Recent post',
    relationship: 'From someone you follow',
    personalization: 'Matches your interests',
    quality: 'High quality content',
    diversity: 'Fresh perspective',
  };

  return {
    factors,
    topReason: reasonMap[topFactor] ?? 'Recommended for you',
  };
}
