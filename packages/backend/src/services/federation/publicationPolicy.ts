import { z } from 'zod';
import { AP_CONTEXT, createUrlBuilders } from '@oxy.so/federation';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import type { DeliveryAuthorizationContext } from '@oxy.so/federation/node';
import { loadPostRecord } from '../../db/posts/postRepository';
import { config } from '../../config';
import { authorsMayFederate } from '../postPublicationPolicy';
import type { PostRecord } from '../../db/posts/postRecord';
import { authorPublicationPolicies, postAuthorIds } from '../postPublicationPolicy';
import { loadPostSafetyDecisions } from '../postSafetyAccess';
import { COMMUNITY_MODERATION_REASON_MAX_LENGTH } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { pollOptions } from '../../db/schema/polls';
import { and, eq } from 'drizzle-orm';
import { postMatchesFederatedObjectSql } from '../../connectors/shared/upstreamPostKey';
import { resolveMentionCommunity } from '../publishAsAccount';
import { accountsWithClosedAudience } from '../../db/userProfile/profileAudience';

const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/**
 * Public protocol pages use current account policy, including every persisted
 * coauthor, and each author's profile audience: a private or followers-only
 * profile's posts never federate (`db/userProfile/profileAudience.ts`).
 */
export async function filterFederatablePosts(
  records: readonly PostRecord[],
): Promise<PostRecord[]> {
  const publicPosts = records.filter(
    (post) => post.status === 'published' && post.visibility === 'public',
  );
  if (!publicPosts.length) return [];
  const authorIds = publicPosts.flatMap(postAuthorIds);
  const [policies, decisions, closedAudience] = await Promise.all([
    authorPublicationPolicies(authorIds),
    loadPostSafetyDecisions(publicPosts, { accessToken: null }),
    accountsWithClosedAudience(authorIds),
  ]);
  return publicPosts.filter(
    (post) =>
      decisions.get(post.id)?.allowed &&
      postAuthorIds(post).every((id) => {
        const policy = policies.get(id);
        return (
          !closedAudience.has(id) &&
          policy?.publicationAllowed &&
          policy.federationAllowed &&
          policy.requiredAudience === null
        );
      }),
  );
}

const iri = z.url();
const addressing = z.array(iri).optional();
// The bare AS2 namespace is the context the shared engine's `sendFollow` emits;
// any other context could smuggle term definitions, so only these two pass.
const ALLOWED_CONTEXTS = new Set([
  JSON.stringify(AP_CONTEXT),
  JSON.stringify('https://www.w3.org/ns/activitystreams'),
]);
const controlFields = {
  '@context': z
    .unknown()
    .optional()
    .refine((value) => value === undefined || ALLOWED_CONTEXTS.has(JSON.stringify(value))),
  id: iri,
  actor: iri,
  to: addressing,
  cc: addressing,
};
const narrowReference = z
  .object({
    id: iri,
    type: z.enum(['Follow', 'Like', 'Announce', 'Block']),
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

/**
 * A deletion a community relays: the member's own retraction or a moderator's
 * removal (Lemmy's: a `Delete` by a moderator, the reason as `summary`).
 * Reference-only like {@link cleanup}, plus the community addressing and the
 * moderator's reason.
 */
const relayedDelete = z
  .object({
    id: iri,
    type: z.literal('Delete'),
    actor: iri,
    to: addressing,
    cc: addressing,
    audience: iri.optional(),
    summary: z.string().max(COMMUNITY_MODERATION_REASON_MAX_LENGTH).optional(),
    object: z.union([iri, z.object({ id: iri, type: z.literal('Tombstone') }).strict()]),
  })
  .strict();
/** A community banning a person (`Block`, the community as the actor and the target). */
const communityBlock = z
  .object({
    ...controlFields,
    type: z.literal('Block'),
    object: iri,
    target: iri,
    summary: z.string().max(COMMUNITY_MODERATION_REASON_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * A local user's vote on a REMOTE poll, in Mastodon's shape: a `Create` of a
 * `Note` in reply to the poll whose only text is the chosen option's `name` —
 * no `content`, media or tags. See {@link authorizePollVote}.
 */
const pollVote = z
  .object({
    ...controlFields,
    type: z.literal('Create'),
    object: z
      .object({
        id: iri,
        type: z.literal('Note'),
        name: z.string().min(1),
        attributedTo: iri,
        to: addressing,
        inReplyTo: iri,
      })
      .strict(),
  })
  .strict();

/** The actor URL a local account is minted with — the engine's builder, bound to our domains. */
const { actor: actorUrl } = createUrlBuilders(
  config.federation.domain,
  config.federation.actorDomain,
);

/** The post a Note id names: a local post by its id, a federated one by its object id. */
async function postForObjectId(objectId: string): Promise<PostRecord | null> {
  let url: URL;
  try {
    url = new URL(objectId);
  } catch {
    return null;
  }
  if (url.hostname === config.federation.domain) {
    const match = /^\/ap\/users\/[^/]+\/posts\/([^/]+)$/.exec(url.pathname);
    return match ? loadPostRecord(decodeURIComponent(match[1])) : null;
  }
  const [row] = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(postMatchesFederatedObjectSql(objectId))
    .limit(1);
  return row ? loadPostRecord(row.id) : null;
}

/**
 * A community hosted here relaying a member's activity (FEP-1b12): an
 * `Announce` whose object is the member's `Create`/`Update` of a post WRITTEN IN
 * that community, or a reference-only `Delete`. The community vouches for what
 * it relays, so the post must still be in it and still public; a local post
 * must also still be federatable under its authors' current policy.
 */
async function authorizeCommunityRelay(
  activity: Record<string, unknown>,
  inner: Record<string, unknown>,
  senderAccountId: string,
): Promise<boolean> {
  const community = await resolveMentionCommunity(senderAccountId);
  if (!community?.username || activity.actor !== actorUrl(community.username)) return false;
  if (inner.type === 'Delete') return relayedDelete.safeParse(inner).success;
  if (inner.type !== 'Create' && inner.type !== 'Update') return false;
  const note = inner.object;
  if (!note || typeof note !== 'object' || Array.isArray(note)) return false;
  const { id: noteId, type: noteType } = note as Record<string, unknown>;
  if (typeof noteId !== 'string' || !['Note', 'Question', 'Page'].includes(String(noteType)))
    return false;
  const post = await postForObjectId(noteId);
  if (!post || post.communityOxyUserId !== senderAccountId) return false;
  if (post.federation != null) return post.status === 'published' && post.visibility === 'public';
  return (await filterFederatablePosts([post])).length === 1;
}

/**
 * A vote publishes nothing of its author's but the option they chose, so it is
 * authorized when it answers a mirrored REMOTE poll with one of that poll's own
 * options — never as free text, and never toward a local post.
 */
async function authorizePollVote(vote: z.infer<typeof pollVote>): Promise<boolean> {
  if (vote.object.attributedTo !== vote.actor) return false;
  const poll = await postForObjectId(vote.object.inReplyTo);
  const pollId = poll?.federation != null ? poll.content.pollId : undefined;
  if (!pollId) return false;
  const [option] = await getDb()
    .select({ id: pollOptions.id })
    .from(pollOptions)
    .where(and(eq(pollOptions.pollId, pollId), eq(pollOptions.text, vote.object.name)))
    .limit(1);
  return option !== undefined;
}

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
  if (activity.type === 'Block') {
    const community = await resolveMentionCommunity(senderAccountId);
    return (
      Boolean(community?.username) &&
      activity.actor === actorUrl(String(community?.username)) &&
      activity.target === activity.actor &&
      communityBlock.safeParse(activity).success
    );
  }
  if (activity.type === 'Create') {
    const vote = pollVote.safeParse(activity);
    if (vote.success) return authorizePollVote(vote.data);
  }
  const object = activity.object;
  if (
    activity.type === 'Announce' &&
    object &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    ['Create', 'Update', 'Delete'].includes(String((object as { type?: unknown }).type))
  )
    return authorizeCommunityRelay(activity, object as Record<string, unknown>, senderAccountId);
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
  // A boost is the booster's own post, so it leaves only an open audience.
  if (
    activity.type === 'Announce' &&
    (await accountsWithClosedAudience([senderAccountId])).has(senderAccountId)
  )
    return false;
  if (
    ['Create', 'Update'].includes(String(activity.type)) &&
    !['Note', 'Question', 'Page'].includes(String(objectType))
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
  if (post.visibility === 'direct')
    return isPostWrite && (await authorizeDirectNoteWrite(activity, post));
  return (await filterFederatablePosts([post])).length === 1;
}

/**
 * A private mention's Create/Update may go out only as a private mention: the
 * activity and its note addressed to named actors — never the public
 * collection, the sender's followers or a community audience — and the post
 * still published under authors whose current policy lets them federate. Oxy's
 * content decision is asked as for the people it is addressed to (a resource
 * grant), so a protected or unavailable author is still refused.
 */
async function authorizeDirectNoteWrite(
  activity: Record<string, unknown>,
  post: PostRecord,
): Promise<boolean> {
  if (post.status !== 'published') return false;
  const note = activity.object as Record<string, unknown>;
  const addressed = [activity.to, activity.cc, note.to, note.cc].flatMap((value) =>
    Array.isArray(value) ? value : value === undefined ? [] : [value],
  );
  const followers = `${String(activity.actor)}/followers`;
  if (
    note.audience !== undefined ||
    addressed.some((entry) => entry === AP_PUBLIC || entry === followers)
  )
    return false;
  if (!(await authorsMayFederate(postAuthorIds(post)))) return false;
  const decisions = await loadPostSafetyDecisions(
    [post],
    { accessToken: null },
    new Map([[post.id, { applicationAudienceAllowed: true, applicationResourceGrant: true }]]),
  );
  return decisions.get(post.id)?.allowed === true;
}
