import { and, arrayOverlaps, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { canonicalFederationHost } from '@oxy.so/federation';
import { getDb } from '../../db/postgres';
import {
  trendStoryPosts,
  type TrendEvidenceSource,
  type TrendStoryEvidence,
} from '../../db/schema/discovery';
import { postContentVariants, postMentions } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { extractUrls } from '../../utils/extractUrls';
import { logger } from '../../utils/logger';
import { getClarityClient } from '../../utils/clarityClient';
import { extractTrendTerms } from './termExtraction';

const MIN_RELEVANCE = 0.5;
const STORY_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface StoredStoryInput {
  id: string;
  name: string;
  terms: string[];
  calculatedAt: Date;
}

interface ContextualMembershipInput {
  storyName: string;
  storyTerms: readonly string[];
  trendTerms: readonly string[];
  hashtags: readonly string[];
  linkTitleTerms?: readonly string[];
  linkDescriptionTerms?: readonly string[];
  quotedTerms?: readonly string[];
  parentTerms?: readonly string[];
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
    : Math.min(1, (present.has(storyName) ? 0.65 : 0) + matchedTerms.length / storyTerms.length * 0.35);
  return { relevance, matchedTerms };
}

export function scoreContextualStoryMembership(input: ContextualMembershipInput): {
  relevance: number;
  matchedTerms: string[];
  sources: TrendEvidenceSource[];
} {
  const direct = scoreStoryMembership(input.storyName, input.storyTerms, [
    ...input.trendTerms,
    ...input.hashtags,
  ]);
  // Context corroborates an author-written candidate; it cannot create one.
  if (direct.relevance < MIN_RELEVANCE) return { ...direct, sources: [] };

  const story = new Set(input.storyTerms);
  const sources: TrendEvidenceSource[] = [];
  if (input.trendTerms.some((term) => story.has(term))) sources.push('author-term');
  if (input.hashtags.some((term) => story.has(term))) sources.push('author-hashtag');
  const corroboration: Array<[TrendEvidenceSource, readonly string[] | undefined, number]> = [
    ['link-title', input.linkTitleTerms, 0.1],
    ['link-description', input.linkDescriptionTerms, 0.05],
    ['quoted-post', input.quotedTerms, 0.12],
    ['reply-parent', input.parentTerms, 0.06],
  ];
  let bonus = 0;
  const matched = new Set(direct.matchedTerms);
  for (const [source, terms, weight] of corroboration) {
    const contextualMatches = (terms ?? []).filter((term) => story.has(term));
    if (contextualMatches.length === 0) continue;
    sources.push(source);
    bonus += weight;
    for (const term of contextualMatches) matched.add(term);
  }
  return { relevance: Math.min(1, direct.relevance + bonus), matchedTerms: [...matched], sources };
}

function termsOf(row: { trendTerms: string[] | null; hashtags: string[] | null } | undefined): string[] {
  return row ? [...(row.trendTerms ?? []), ...(row.hashtags ?? [])] : [];
}

function domainOf(url: string): string | undefined {
  try {
    return canonicalFederationHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

/** Persist deterministic membership plus its auditable contextual evidence. */
export async function saveStoryMemberships(stories: readonly StoredStoryInput[]): Promise<number> {
  let inserted = 0;
  for (const story of stories) {
    const windowStart = new Date(story.calculatedAt.getTime() - STORY_WINDOW_MS);
    const matches = await getDb().select({
      postId: posts.id,
      trendTerms: posts.classificationTrendTerms,
      hashtags: posts.hashtags,
      quoteOf: posts.quoteOf,
      parentPostId: posts.parentPostId,
    }).from(posts).where(and(
      gte(posts.createdAt, windowStart), eq(posts.visibility, 'public'), eq(posts.status, 'published'),
      or(arrayOverlaps(posts.classificationTrendTerms, story.terms), arrayOverlaps(posts.hashtags, story.terms)),
    ));

    const postIds = matches.map((post) => post.postId);
    if (postIds.length === 0) continue;
    const referenceIds = [...new Set(matches.flatMap((post) => [post.quoteOf, post.parentPostId])
      .filter((id): id is string => Boolean(id)))];
    const [bodies, references, mentions, children] = await Promise.all([
      getDb().select({ postId: postContentVariants.postId, body: postContentVariants.body, tag: postContentVariants.tag })
        .from(postContentVariants).where(and(inArray(postContentVariants.postId, postIds), eq(postContentVariants.position, 0))),
      referenceIds.length === 0 ? Promise.resolve([]) : getDb().select({
        postId: posts.id, trendTerms: posts.classificationTrendTerms, hashtags: posts.hashtags,
      }).from(posts).where(inArray(posts.id, referenceIds)),
      getDb().select({ postId: postMentions.postId }).from(postMentions).where(inArray(postMentions.postId, postIds)),
      getDb().select({ boostOf: posts.boostOf, quoteOf: posts.quoteOf, parentPostId: posts.parentPostId })
        .from(posts).where(and(gte(posts.createdAt, windowStart), eq(posts.visibility, 'public'),
          eq(posts.status, 'published'), or(
          inArray(posts.boostOf, postIds), inArray(posts.quoteOf, postIds), inArray(posts.parentPostId, postIds),
        ))),
    ]);
    const bodyByPost = new Map(bodies.map((row) => [row.postId, row]));
    const referenceById = new Map(references.map((row) => [row.postId, row]));
    const mentionCount = new Map<string, number>();
    for (const row of mentions) mentionCount.set(row.postId, (mentionCount.get(row.postId) ?? 0) + 1);
    const amplification = new Map<string, { repostsCount: number; quotesCount: number; repliesCount: number }>();
    for (const child of children) {
      const bump = (id: string | null, key: 'repostsCount' | 'quotesCount' | 'repliesCount'): void => {
        if (!id) return;
        const counts = amplification.get(id) ?? { repostsCount: 0, quotesCount: 0, repliesCount: 0 };
        counts[key] += 1;
        amplification.set(id, counts);
      };
      bump(child.boostOf, 'repostsCount');
      bump(child.quoteOf, 'quotesCount');
      bump(child.parentPostId, 'repliesCount');
    }

    const urls = [...new Set(bodies.flatMap((row) => extractUrls(row.body)))];
    const documents = urls.length === 0 ? [] : await (await getClarityClient()).indexing.resolve({ urls, waitMs: 2_000 }).then((response) => response.data).catch((error: unknown) => {
      logger.debug('[Trending] Link evidence unavailable', { count: urls.length, error });
      return [];
    });
    const documentByUrl = new Map(documents.flatMap((resolution) => resolution.document ? [[resolution.url, resolution.document] as const] : []));

    const memberships = matches.flatMap((post) => {
      const body = bodyByPost.get(post.postId);
      const resolved = (body ? extractUrls(body.body) : []).map((url) => documentByUrl.get(url))
        .filter((document) => document !== undefined);
      const languages = body?.tag ? [body.tag] : undefined;
      const scored = scoreContextualStoryMembership({
        storyName: story.name,
        storyTerms: story.terms,
        trendTerms: post.trendTerms ?? [],
        hashtags: post.hashtags ?? [],
        linkTitleTerms: resolved.flatMap((preview) => extractTrendTerms({ text: preview.title, languages })),
        linkDescriptionTerms: resolved.flatMap((preview) => extractTrendTerms({ text: preview.description, languages })),
        quotedTerms: termsOf(post.quoteOf ? referenceById.get(post.quoteOf) : undefined),
        parentTerms: termsOf(post.parentPostId ? referenceById.get(post.parentPostId) : undefined),
      });
      const counts = amplification.get(post.postId) ?? { repostsCount: 0, quotesCount: 0, repliesCount: 0 };
      const evidence: TrendStoryEvidence = {
        sources: scored.sources,
        linkUrls: resolved.map((document) => document.canonicalUrl),
        linkDomains: [...new Set(resolved.map((document) => domainOf(document.canonicalUrl))
          .filter((domain): domain is string => Boolean(domain)))],
        mentionsCount: mentionCount.get(post.postId) ?? 0,
        ...counts,
      };
      return scored.relevance >= MIN_RELEVANCE
        ? [{ trendId: story.id, postId: post.postId, relevance: scored.relevance, matchedTerms: scored.matchedTerms, evidence }]
        : [];
    });

    if (memberships.length === 0) continue;
    const landed = await getDb().insert(trendStoryPosts).values(memberships)
      .onConflictDoUpdate({
        target: [trendStoryPosts.trendId, trendStoryPosts.postId],
        set: { relevance: sql`excluded.relevance`, matchedTerms: sql`excluded.matched_terms`, evidence: sql`excluded.evidence` },
      }).returning({ id: trendStoryPosts.id });
    inserted += landed.length;
  }
  return inserted;
}
