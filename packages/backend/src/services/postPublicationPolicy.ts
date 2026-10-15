import type { PublicationPolicy, SafetyRequester } from '@oxy.so/contracts';
import { PostVisibility } from '@mention/shared-types';
import type { PostRecord } from '../db/posts/postRecord';
import { getServiceOxyClient } from '../utils/oxyHelpers';

export class PostPublicationPolicyError extends Error {
  constructor(
    public readonly status: 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'PostPublicationPolicyError';
  }
}

export async function requesterPublicationPolicy(
  requester: SafetyRequester,
): Promise<PublicationPolicy> {
  try {
    const policy = await getServiceOxyClient().safety.publicationPolicy(requester);
    if (!policy.publicationAllowed)
      throw new PostPublicationPolicyError(403, 'Publishing is unavailable for this account');
    return policy;
  } catch (error) {
    if (error instanceof PostPublicationPolicyError) throw error;
    throw new PostPublicationPolicyError(503, 'Publishing permissions are temporarily unavailable');
  }
}

/** Default a protected author's new post to private; an explicit broader audience is refused. */
export function publicationVisibility(
  policy: PublicationPolicy,
  requested: unknown,
  fallback = PostVisibility.PUBLIC,
): PostVisibility {
  if (policy.requiredAudience === 'private') {
    if (
      requested !== undefined &&
      requested !== null &&
      requested !== '' &&
      requested !== PostVisibility.PRIVATE
    )
      throw new PostPublicationPolicyError(403, 'This account can publish only private posts');
    return PostVisibility.PRIVATE;
  }
  return fallback;
}

/** The service supplies persisted authors, never a caller's claimed identity. No positive cache. */
export async function authorPublicationPolicies(
  accountIds: readonly string[],
): Promise<Map<string, PublicationPolicy>> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  const policies = new Map<string, PublicationPolicy>();
  try {
    for (let index = 0; index < ids.length; index += 100) {
      const result = await getServiceOxyClient().safety.publicationPolicies({
        authorAccountIds: ids.slice(index, index + 100),
      });
      for (const item of result.items) policies.set(item.authorAccountId, item.policy);
    }
    if (ids.some((id) => !policies.has(id))) throw new Error('Incomplete publication decisions');
    return policies;
  } catch {
    throw new PostPublicationPolicyError(503, 'Publishing permissions are temporarily unavailable');
  }
}

export function postAuthorIds(
  post: Pick<PostRecord, 'oxyUserId' | 'writtenByOxyUserId' | 'authorship'>,
): string[] {
  return [
    ...new Set([
      ...(post.oxyUserId ? [post.oxyUserId] : []),
      ...(post.writtenByOxyUserId ? [post.writtenByOxyUserId] : []),
      ...post.authorship
        .filter((entry) => entry.status === 'accepted' || entry.status === 'pending')
        .map((entry) => entry.oxyUserId),
    ]),
  ];
}

export async function assertAuthorsCanPublish(
  accountIds: readonly string[],
  visibility: PostVisibility,
  collaborative = false,
): Promise<void> {
  const policies = await authorPublicationPolicies(accountIds);
  for (const policy of policies.values()) {
    if (
      !policy.publicationAllowed ||
      (policy.requiredAudience && visibility !== policy.requiredAudience) ||
      (collaborative && !policy.collaborationAllowed)
    )
      throw new PostPublicationPolicyError(
        403,
        'The current account protections do not allow this publication',
      );
  }
}

export async function assertStoredPostCanPublish(post: PostRecord): Promise<void> {
  await assertAuthorsCanPublish(
    postAuthorIds(post),
    post.visibility,
    post.authorship.some(
      (entry) =>
        entry.role === 'collaborator' &&
        (entry.status === 'pending' || entry.status === 'accepted'),
    ),
  );
}

/** Public protocols cannot carry protected authorship, even if an old row was public. */
export async function authorsMayFederate(accountIds: readonly string[]): Promise<boolean> {
  const policies = await authorPublicationPolicies(accountIds);
  return [...policies.values()].every(
    (policy) =>
      policy.publicationAllowed && policy.federationAllowed && policy.requiredAudience === null,
  );
}
