import type { ContentAccessInput, SafetyDecision, SafetyRequester } from '@oxy.so/contracts';
import { loadPostSafetyAssessments } from '../db/posts/postSafetyRepository';
import type { FeedSafetyPostShape } from '../mtn/feed/feedSafety';
import { decideContentAccess } from './contentAccessBatcher';
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
 * The content-decision inputs for a whole hydration graph, one per unique post.
 * One local query covers every revision's assessment.
 */
export async function postSafetyItems(
  posts: readonly SafetyPost[],
  applicationAccess: ReadonlyMap<string, PostSafetyApplicationAccess> = new Map(),
): Promise<ContentAccessInput[]> {
  const uniquePosts = [...new Map(posts.map((post) => [post.id, post])).values()];
  if (!uniquePosts.length) return [];
  const assessments = await loadPostSafetyAssessments(uniquePosts.map((post) => post.id));
  return uniquePosts.map((post) => ({
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
  }));
}

/**
 * Resolve a whole hydration graph with current, canonical decisions. No positive
 * authorization outlives the request: changing privacy, supervision or contacts
 * takes effect on the next read, including a read served from a cached post
 * record. Within a request the decisions are batched (see `contentAccessBatcher`).
 */
export async function loadPostSafetyDecisions(
  posts: readonly SafetyPost[],
  requester: SafetyRequester,
  applicationAccess: ReadonlyMap<string, PostSafetyApplicationAccess> = new Map(),
): Promise<Map<string, SafetyDecision>> {
  const items = await postSafetyItems(posts, applicationAccess);
  const decisions = await decideContentAccess(items, requester);
  return new Map(
    items.map((item) => [item.resourceId, decisions.get(item.resourceId) ?? unavailable]),
  );
}
