/**
 * Infra-heavier "related / discovery" source modules (Phase 4).
 *
 * These need more than a lean single-index query: overlap-based similarity
 * (`moreLikeThis`), geo/region proximity (`nearby`), and follower-growth ranking
 * (`risingCreators`, backed by a periodic snapshot job). They follow the Phase 1/2
 * authoring pattern exactly — a bounded query selecting `FEED_FIELDS`,
 * `.maxTimeMS(5000)`, capped to `cap`, soft-failing to `[]` — and never
 * reimplement ranking/hydration (the engine wraps them). SFW gating uses the
 * shared {@link DISCOVERY_SAFE_MATCH} unless the viewer opted into sensitive
 * content.
 */

import mongoose from 'mongoose';
import { PostVisibility, MtnConfig } from '@mention/shared-types';
import { Post } from '../../../../models/Post';
import { FEED_FIELDS } from '../../FeedAPI';
import { DISCOVERY_SAFE_MATCH } from '../../feedSafety';
import { logger } from '../../../../utils/logger';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/**
 * Overfetch factor for `moreLikeThis`: fetch this many × the page cap of recent
 * candidates so the in-memory overlap re-rank has a meaningful pool to sort,
 * bounded by {@link MORE_LIKE_THIS_MAX_POOL}.
 */
const MORE_LIKE_THIS_POOL_MULTIPLIER = 4;

/** Hard ceiling on the `moreLikeThis` candidate pool (memory + sort bound). */
const MORE_LIKE_THIS_MAX_POOL = 500;

/** Cap on the number of seed topics/hashtags fed into the `$in` match. */
const MAX_SEED_TERMS = 20;

/** Normalize a loose string array: lowercase, trim empties, dedupe, cap length. */
function normalizeTerms(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const term = raw.trim().toLowerCase();
    if (term) seen.add(term);
    if (seen.size >= cap) break;
  }
  return Array.from(seen);
}

/** The similarity seed: the topics/hashtags/author a `moreLikeThis` query matches on. */
interface MoreLikeThisSeed {
  topics: string[];
  hashtags: string[];
  authorId: string;
  /** The seed post's id to exclude from results (only on the postId-driven path). */
  excludeId: mongoose.Types.ObjectId | null;
}

/**
 * Resolve the similarity seed from params. `postId` loads the seed post and reads
 * its classification topics / hashtags / author; otherwise the seed is taken
 * directly from `{ topics, hashtags, authorId }` (builder-composable, no lookup).
 * Returns `null` when a `postId` was given but is invalid / not found.
 */
async function resolveSeed(params: Record<string, unknown>): Promise<MoreLikeThisSeed | null> {
  const postId = typeof params.postId === 'string' ? params.postId : '';

  if (postId) {
    if (!mongoose.Types.ObjectId.isValid(postId)) return null;
    let seedPost: { postClassification?: { topics?: unknown }; hashtags?: unknown; oxyUserId?: unknown } | null;
    try {
      seedPost = await Post.findById(postId)
        .select('postClassification.topics hashtags oxyUserId')
        .lean();
    } catch (error) {
      logger.warn('[moreLikeThis source] Failed to load seed post', { postId, error });
      return null;
    }
    if (!seedPost) return null;
    return {
      topics: normalizeTerms(seedPost.postClassification?.topics, MAX_SEED_TERMS),
      hashtags: normalizeTerms(seedPost.hashtags, MAX_SEED_TERMS),
      authorId: typeof seedPost.oxyUserId === 'string' ? seedPost.oxyUserId : '',
      excludeId: new mongoose.Types.ObjectId(postId),
    };
  }

  return {
    topics: normalizeTerms(params.topics, MAX_SEED_TERMS),
    hashtags: normalizeTerms(params.hashtags, MAX_SEED_TERMS),
    authorId: typeof params.authorId === 'string' ? params.authorId : '',
    excludeId: null,
  };
}

/** Count a candidate's topic/hashtag/author overlap with the seed (the relevance score). */
function overlapScore(
  post: CandidatePost,
  topicSet: Set<string>,
  tagSet: Set<string>,
  authorId: string,
): number {
  let score = 0;
  const classification = post.postClassification as { topics?: unknown } | undefined;
  const topics = Array.isArray(classification?.topics) ? classification.topics : [];
  for (const topic of topics) {
    if (typeof topic === 'string' && topicSet.has(topic.toLowerCase())) score += 1;
  }
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  for (const tag of hashtags) {
    if (typeof tag === 'string' && tagSet.has(tag.toLowerCase())) score += 1;
  }
  if (authorId && post.oxyUserId === authorId) score += 1;
  return score;
}

/** Epoch ms of a candidate's `createdAt` (0 when absent), for the recency tie-break. */
function createdAtMs(post: CandidatePost): number {
  return new Date((post.createdAt as Date | string | undefined) ?? 0).getTime();
}

/**
 * `moreLikeThis`: OVERLAP-based "related posts" — no embeddings. Resolves a seed
 * (a `postId`, or a direct `{ topics, hashtags, authorId }`) and returns recent
 * public SFW posts that share any of its classified topics, hashtags, or author,
 * ranked by how many of those overlap (`finalScore`). The seed post itself and
 * boosts (empty bodies) are excluded. Bounded overfetch + in-memory re-rank.
 */
export const moreLikeThisSource: SourceModule = {
  id: 'moreLikeThis',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const seed = await resolveSeed(params);
    if (!seed) return [];
    if (seed.topics.length === 0 && seed.hashtags.length === 0 && !seed.authorId) return [];

    const orConditions: Record<string, unknown>[] = [];
    if (seed.topics.length > 0) orConditions.push({ 'postClassification.topics': { $in: seed.topics } });
    if (seed.hashtags.length > 0) orConditions.push({ hashtags: { $in: seed.hashtags } });
    if (seed.authorId) orConditions.push({ oxyUserId: seed.authorId });

    const allowSensitive = ctx.showSensitiveContent === true;
    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);
    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: { $gte: windowStart },
      ...(allowSensitive ? {} : DISCOVERY_SAFE_MATCH),
      $and: [
        { $or: orConditions },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };
    if (seed.excludeId) match._id = { $ne: seed.excludeId };

    const poolSize = Math.min(cap * MORE_LIKE_THIS_POOL_MULTIPLIER, MORE_LIKE_THIS_MAX_POOL);
    const candidates = (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
      .limit(poolSize)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];

    const topicSet = new Set(seed.topics);
    const tagSet = new Set(seed.hashtags);
    return candidates
      .map((post) => {
        post.finalScore = overlapScore(post, topicSet, tagSet, seed.authorId);
        return post;
      })
      .sort((a, b) => {
        const diff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
        return diff !== 0 ? diff : createdAtMs(b) - createdAtMs(a);
      })
      .slice(0, cap);
  },
};

export const relatedSourceModules: SourceModule[] = [moreLikeThisSource];
