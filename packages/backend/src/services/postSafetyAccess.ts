import type { ContentAccessInput, SafetyDecision, SafetyRequester } from '@oxy.so/contracts';
import { loadPostSafetyAssessments } from '../db/posts/postSafetyRepository';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import type { FeedSafetyPostShape } from '../mtn/feed/feedSafety';
import {
  postSafetyClassification,
  type SafetyMaterialPost,
} from './contentClassification/safetyAssessment';

interface SafetyPost extends SafetyMaterialPost, FeedSafetyPostShape {
  id: string;
  oxyUserId?: string | null;
  visibility?: string;
}

export type PostSafetyApplicationAccess = Pick<
  ContentAccessInput,
  'applicationAudienceAllowed' | 'applicationResourceGrant' | 'operation'
>;

const unavailable: SafetyDecision = {
  allowed: false,
  reason: 'unavailable',
  policyVersion: '2',
};

/**
 * Resolve a whole hydration graph with current, canonical decisions. No positive
 * authorization is cached: changing privacy, supervision or contacts takes effect
 * on the next read, including a read served from a cached post record.
 */
export async function loadPostSafetyDecisions(
  posts: readonly SafetyPost[],
  requester: SafetyRequester,
  applicationAccess: ReadonlyMap<string, PostSafetyApplicationAccess> = new Map(),
): Promise<Map<string, SafetyDecision>> {
  const uniquePosts = [...new Map(posts.map((post) => [post.id, post])).values()];
  if (!uniquePosts.length) return new Map();
  const client = getServiceOxyClient();
  const contents = new Map<string, SafetyDecision>();
  // One local query covers every revision; each remote request is a bounded
  // batch, never a separate policy lookup for a post or nested reference.
  const assessments = await loadPostSafetyAssessments(uniquePosts.map((post) => post.id));
  const jobs: Array<() => Promise<void>> = [];
  for (let index = 0; index < uniquePosts.length; index += 100) {
    const batch = uniquePosts.slice(index, index + 100);
    jobs.push(async () => {
      const result = await client.safety.contentAccessBatch(
        {
          items: batch.map((post) => ({
            resourceId: post.id,
            authorAccountId: post.oxyUserId ?? undefined,
            audience:
              post.visibility === 'private'
                ? 'private'
                : post.visibility === 'followers_only'
                  ? 'followers'
                  : 'public',
            applicationAudienceAllowed: !post.visibility || post.visibility === 'public',
            ...applicationAccess.get(post.id),
            classification: postSafetyClassification(post, assessments.get(post.id)),
          })),
        },
        requester,
      );
      for (const item of result.items) contents.set(item.resourceId, item.decision);
    });
  }
  // Bound concurrency even if a large thread expands the graph.
  for (let index = 0; index < jobs.length; index += 4)
    await Promise.all(jobs.slice(index, index + 4).map((run) => run()));
  return new Map(uniquePosts.map((post) => [post.id, contents.get(post.id) ?? unavailable]));
}
