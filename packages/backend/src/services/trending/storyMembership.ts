import { and, arrayOverlaps, eq, gte, or } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { trendStoryPosts } from '../../db/schema/discovery';
import { posts } from '../../db/schema/posts';

const MIN_RELEVANCE = 0.5;
const STORY_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface StoredStoryInput {
  id: string;
  name: string;
  terms: string[];
  calculatedAt: Date;
}

export function scoreStoryMembership(
  storyName: string,
  storyTerms: readonly string[],
  postTerms: readonly string[],
): { relevance: number; matchedTerms: string[] } {
  const present = new Set(postTerms);
  const matchedTerms = storyTerms.filter((term) => present.has(term));
  const relevance = storyTerms.length === 1
    ? (matchedTerms.length === 1 ? 1 : 0)
    : Math.min(
        1,
        (present.has(storyName) ? 0.65 : 0) + matchedTerms.length / storyTerms.length * 0.35,
      );
  return { relevance, matchedTerms };
}

/** Persist the same deterministic post membership for live and backfilled stories. */
export async function saveStoryMemberships(stories: readonly StoredStoryInput[]): Promise<number> {
  let inserted = 0;
  for (const story of stories) {
    const windowStart = new Date(story.calculatedAt.getTime() - STORY_WINDOW_MS);
    const matches = await getDb()
      .select({
        postId: posts.id,
        trendTerms: posts.classificationTrendTerms,
        hashtags: posts.hashtags,
      })
      .from(posts)
      .where(and(
        gte(posts.createdAt, windowStart),
        eq(posts.visibility, 'public'),
        eq(posts.status, 'published'),
        or(
          arrayOverlaps(posts.classificationTrendTerms, story.terms),
          arrayOverlaps(posts.hashtags, story.terms),
        ),
      ));

    const memberships = matches.flatMap((post) => {
      const scored = scoreStoryMembership(story.name, story.terms, [
        ...(post.trendTerms ?? []),
        ...(post.hashtags ?? []),
      ]);
      return scored.relevance >= MIN_RELEVANCE
        ? [{ trendId: story.id, postId: post.postId, ...scored }]
        : [];
    });

    if (memberships.length === 0) continue;
    const landed = await getDb()
      .insert(trendStoryPosts)
      .values(memberships)
      .onConflictDoNothing({ target: [trendStoryPosts.trendId, trendStoryPosts.postId] })
      .returning({ id: trendStoryPosts.id });
    inserted += landed.length;
  }
  return inserted;
}
