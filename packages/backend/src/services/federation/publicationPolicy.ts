import { z } from 'zod';
import { AP_CONTEXT } from '@oxy.so/federation';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import type { DeliveryAuthorizationContext } from '@oxy.so/federation/node';
import { loadPostRecord } from '../../db/posts/postRepository';
import { config } from '../../config';
import { authorsMayFederate } from '../postPublicationPolicy';
import type { PostRecord } from '../../db/posts/postRecord';
import { authorPublicationPolicies, postAuthorIds } from '../postPublicationPolicy';
import { loadPostSafetyDecisions } from '../postSafetyAccess';

/** Public protocol pages use current account policy, including every persisted coauthor. */
export async function filterFederatablePosts(
  records: readonly PostRecord[],
): Promise<PostRecord[]> {
  const publicPosts = records.filter(
    (post) => post.status === 'published' && post.visibility === 'public',
  );
  if (!publicPosts.length) return [];
  const [policies, decisions] = await Promise.all([
    authorPublicationPolicies(publicPosts.flatMap(postAuthorIds)),
    loadPostSafetyDecisions(publicPosts, { accessToken: null }),
  ]);
  return publicPosts.filter(
    (post) =>
      decisions.get(post.id)?.allowed &&
      postAuthorIds(post).every((id) => {
        const policy = policies.get(id);
        return (
          policy?.publicationAllowed && policy.federationAllowed && policy.requiredAudience === null
        );
      }),
  );
}

const iri = z.url();
const addressing = z.array(iri).optional();
const controlFields = {
  '@context': z
    .unknown()
    .optional()
    .refine((value) => value === undefined || JSON.stringify(value) === JSON.stringify(AP_CONTEXT)),
  id: iri,
  actor: iri,
  to: addressing,
  cc: addressing,
};
const narrowReference = z
  .object({
    id: iri,
    type: z.enum(['Follow', 'Like', 'Announce']),
    actor: iri,
    object: iri,
    to: addressing,
    cc: addressing,
  })
  .strict();
const cleanup = z.union([
  z
    .object({
      ...controlFields,
      type: z.literal('Delete'),
      object: z.union([iri, z.object({ id: iri, type: z.literal('Tombstone') }).strict()]),
    })
    .strict(),
  z.object({ ...controlFields, type: z.literal('Undo'), object: narrowReference }).strict(),
]);
const follow = z.object({ ...controlFields, type: z.literal('Follow'), object: iri }).strict();
const accept = z
  .object({
    ...controlFields,
    type: z.literal('Accept'),
    object: narrowReference.extend({ type: z.literal('Follow') }),
  })
  .strict();

/** The sender comes from the app's durable job, never from the activity's actor URL. */
export async function authorizeFederationDelivery({
  activity,
  senderAccountId,
}: DeliveryAuthorizationContext): Promise<boolean> {
  if (!senderAccountId) return false;
  // Only known reference-only retractions bypass current publication permission.
  // Unknown text/media fields are refused, including fields on the outer envelope.
  if (activity.type === 'Delete' || activity.type === 'Undo')
    return cleanup.safeParse(activity).success;
  if (!(await authorsMayFederate([senderAccountId]))) return false;
  if (activity.type === 'Follow') return follow.safeParse(activity).success;
  if (activity.type === 'Accept') return accept.safeParse(activity).success;
  const object = activity.object;
  const objectType =
    object && typeof object === 'object' && 'type' in object ? object.type : undefined;
  const objectId =
    typeof object === 'string'
      ? object
      : object && typeof object === 'object' && 'id' in object && typeof object.id === 'string'
        ? object.id
        : undefined;
  if (
    activity.type === 'Update' &&
    ['Person', 'Organization', 'Service', 'Group', 'Application'].includes(String(objectType))
  ) {
    if (!objectId || objectId !== activity.actor) return false;
    const access = await getServiceOxyClient().safety.profileAccess(
      { subjectAccountId: senderAccountId },
      { accessToken: null },
    );
    return access.allowed;
  }
  if (!['Create', 'Update', 'Like', 'Announce'].includes(String(activity.type)) || !objectId)
    return false;
  if (
    ['Create', 'Update'].includes(String(activity.type)) &&
    !['Note', 'Question'].includes(String(objectType))
  )
    return false;
  let url: URL;
  try {
    url = new URL(objectId);
  } catch {
    return false;
  }
  const isPostWrite = activity.type === 'Create' || activity.type === 'Update';
  if (url.hostname !== config.federation.domain) return !isPostWrite;
  const match = /^\/ap\/users\/[^/]+\/posts\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  const post = await loadPostRecord(decodeURIComponent(match[1]));
  if (!post || (isPostWrite && !postAuthorIds(post).includes(senderAccountId))) return false;
  return (await filterFederatablePosts([post])).length === 1;
}
