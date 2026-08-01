/**
 * Print what a term's posts actually STORE — the one question the public API
 * cannot answer.
 *
 * Written after six rounds of black-box elimination failed to explain why
 * `mention` was the network's biggest trend while appearing in no post's text,
 * no hashtag array, no topic list and no mention link. Every one of those was
 * ruled out through the API; the field that must therefore hold it —
 * `postClassification.trendTerms` — is the only one no endpoint exposes.
 *
 * Read-only. Prints, changes nothing.
 *
 *   bun packages/backend/dist/src/scripts/inspectTrendTerms.js <term> [limit]
 *
 * Over the SSM tunnel (see `~/.claude` memory `prod-mongo-backfill-access`) or
 * as a Fargate one-shot in-VPC when the tunnel is unavailable, which it is
 * whenever the instance's SSM agent is unhealthy.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';
import { trendTermMatch } from '../services/trending/termSpace';

/** Posts sampled. Enough to see a pattern, small enough to read. */
const DEFAULT_LIMIT = 10;

interface InspectedPost {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  oxyUserId?: string;
  hashtags?: string[];
  content?: { variants?: Array<{ text?: string; source?: string }> };
  postClassification?: {
    trendTerms?: string[];
    topics?: string[];
    hashtagsNorm?: string[];
    version?: number;
    status?: string;
  };
}

async function main(): Promise<void> {
  const term = (process.argv[2] ?? '').trim().toLowerCase();
  const limit = Number(process.argv[3]) || DEFAULT_LIMIT;
  if (!term) {
    logger.error('[inspectTrendTerms] usage: inspectTrendTerms <term> [limit]');
    process.exit(1);
  }

  // Same connection shape as the other one-shots: the script owns the
  // lifecycle, and `dbName` is derived from NODE_ENV — `NODE_ENV=production` is
  // mandatory or this silently reads `mention-development`.
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mention', {
    dbName: `mention-${process.env.NODE_ENV || 'development'}`,
  });

  // Shares the batch's own definition, so this cannot look somewhere the real
  // thing does not — the point is to find WHICH field carries the term.
  const posts = await Post.find(
    trendTermMatch(term),
    {
      createdAt: 1,
      oxyUserId: 1,
      hashtags: 1,
      'content.variants.text': 1,
      'content.variants.source': 1,
      'postClassification.trendTerms': 1,
      'postClassification.topics': 1,
      'postClassification.hashtagsNorm': 1,
      'postClassification.version': 1,
      'postClassification.status': 1,
    },
  )
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<InspectedPost[]>();

  logger.info('[inspectTrendTerms] sampled posts', { term, count: posts.length });

  for (const post of posts) {
    const classification = post.postClassification ?? {};
    // Which container actually carries it — the whole question.
    const carriedBy = [
      classification.trendTerms?.includes(term) ? 'trendTerms' : null,
      post.hashtags?.includes(term) ? 'hashtags' : null,
      classification.topics?.includes(term) ? 'topics' : null,
    ].filter(Boolean);

    logger.info('[inspectTrendTerms] post', {
      id: String(post._id),
      createdAt: post.createdAt?.toISOString(),
      carriedBy,
      classifierVersion: classification.version,
      status: classification.status,
      // Every rendition, not just the primary: if the classifier read a
      // different string from the one the DTO renders, the difference is here.
      variants: (post.content?.variants ?? []).map((variant) => ({
        source: variant.source,
        text: (variant.text ?? '').slice(0, 200),
        // Does the stored text contain the term AT ALL? A `false` here beside a
        // `trendTerms` hit is the whole finding.
        containsTerm: (variant.text ?? '').toLowerCase().includes(term),
      })),
      trendTerms: classification.trendTerms,
      hashtags: post.hashtags,
      hashtagsNorm: classification.hashtagsNorm,
      topics: classification.topics,
    });
  }

  // One-shot scripts MUST disconnect and exit: imported singletons (BullMQ
  // Redis connections, MediaCache workers) otherwise keep a Fargate task alive
  // forever. See AGENTS.md § one-shot scripts.
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((error) => {
  logger.error('[inspectTrendTerms] failed', error);
  process.exit(1);
});
