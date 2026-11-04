import { PostVisibility } from '@mention/shared-types';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { posts } from '../schema/posts';
import { postRecipients } from '../schema/postContent';

/**
 * WHO A POST IS FOR — the audience rules every post write and every
 * private-mention read share.
 *
 * Two halves, both owned here so neither can drift from the other:
 *
 *  - {@link resolvePostAudience}: the visibility and recipients a post is STORED
 *    with. A reply can never be wider than its parent, and a reply in a
 *    private-mention conversation stays in it. `writePostRecord` applies it to
 *    every insert, native and federated alike, so no creation path can store a
 *    public reply to a private conversation.
 *  - {@link directPostParticipantSql}: the SQL form of "this viewer takes part in
 *    this direct post", for the reads that list a conversation (a thread's
 *    replies, the private-mentions inbox). Listings that are not a conversation
 *    filter visibility with an allowlist and never name `direct` at all.
 */

/** How wide each visibility is: a reply's rank may never exceed its parent's. */
const VISIBILITY_RANK: Record<PostVisibility, number> = {
  [PostVisibility.PUBLIC]: 3,
  [PostVisibility.FOLLOWERS_ONLY]: 2,
  [PostVisibility.DIRECT]: 1,
  [PostVisibility.PRIVATE]: 0,
};

/** The parent facts a reply's audience is decided from. */
export interface ParentAudience {
  oxyUserId: string | null;
  visibility: PostVisibility;
  recipients: readonly string[];
}

/**
 * The visibility and recipients a post is stored with.
 *
 * Visibility is the NARROWER of the requested one and the parent's: replying to
 * a followers-only post cannot make a public post, and replying to a private
 * mention cannot make anything wider than a private mention. A `direct` post is
 * addressed to its explicit `recipients` (a federated note's addressees) or,
 * when none are given, the people it mentions — plus, in a private-mention
 * conversation, the parent's author and recipients. The author is never their
 * own recipient. Every other visibility has no recipients.
 */
export function resolvePostAudience(
  input: {
    authorId: string | null;
    visibility: PostVisibility;
    recipients?: readonly string[];
    mentions?: readonly string[];
  },
  parent: ParentAudience | null,
): { visibility: PostVisibility; recipients: string[] } {
  const visibility =
    parent && VISIBILITY_RANK[parent.visibility] < VISIBILITY_RANK[input.visibility]
      ? parent.visibility
      : input.visibility;
  if (visibility !== PostVisibility.DIRECT) return { visibility, recipients: [] };

  const inherited =
    parent?.visibility === PostVisibility.DIRECT
      ? [parent.oxyUserId ?? '', ...parent.recipients]
      : [];
  const recipients = [
    ...new Set([...(input.recipients ?? input.mentions ?? []), ...inherited]),
  ].filter((id) => id && id !== input.authorId);
  return { visibility, recipients };
}

/**
 * Whether this author may reply under this parent: always, unless the parent is
 * a private mention they are neither the author nor a recipient of.
 */
export function mayJoinConversation(parent: ParentAudience, authorId: string | null): boolean {
  if (parent.visibility !== PostVisibility.DIRECT) return true;
  return (
    Boolean(authorId) &&
    (parent.oxyUserId === authorId || parent.recipients.includes(authorId ?? ''))
  );
}

/** The audience facts of the post a reply is written under, or `null`. */
export async function loadParentAudience(
  parentPostId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ParentAudience | null> {
  const [[parent], recipients] = await Promise.all([
    db
      .select({ oxyUserId: posts.oxyUserId, visibility: posts.visibility })
      .from(posts)
      .where(eq(posts.id, parentPostId))
      .limit(1),
    loadPostRecipients(parentPostId, db),
  ]);
  if (!parent) return null;
  return {
    oxyUserId: parent.oxyUserId,
    visibility: parent.visibility as PostVisibility,
    recipients,
  };
}

/** A post's recipients, in a stable order. */
export async function loadPostRecipients(
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ oxyUserId: postRecipients.oxyUserId })
    .from(postRecipients)
    .where(eq(postRecipients.postId, postId))
    .orderBy(postRecipients.oxyUserId);
  return rows.map((row) => row.oxyUserId);
}

/** Add recipients to a post, ignoring any it already has. */
export async function insertPostRecipients(
  postId: string,
  recipients: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const unique = [...new Set(recipients.filter(Boolean))];
  if (unique.length === 0) return;
  await db
    .insert(postRecipients)
    .values(unique.map((oxyUserId) => ({ postId, oxyUserId })))
    .onConflictDoNothing();
}

/**
 * A `direct` post this viewer takes part in: they wrote it or it is addressed to
 * them. The one SQL spelling of the read ACL `PostHydrationService` applies, for
 * the conversation reads that must find such posts before hydrating them.
 */
export function directPostParticipantSql(viewerId: string): SQL {
  return and(
    eq(posts.visibility, PostVisibility.DIRECT),
    or(
      eq(posts.oxyUserId, viewerId),
      inArray(
        posts.id,
        getDb()
          .select({ postId: postRecipients.postId })
          .from(postRecipients)
          .where(eq(postRecipients.oxyUserId, viewerId)),
      ),
    ),
  ) as SQL;
}

/**
 * The replies a viewer may see in a thread: public ones, plus — signed in —
 * followers-only replies by the viewer or an author they follow, and the
 * private mentions they take part in. A reply to a followers-only or direct
 * post inherits that audience (`resolvePostAudience`), so a public-only thread
 * read would hide exactly the replies its readers are entitled to. Hydration
 * still applies the full ACL to everything this admits.
 */
export function threadReplyVisibilitySql(
  viewerId: string | undefined,
  followingIds: readonly string[] = [],
): SQL {
  const publicReplies = eq(posts.visibility, PostVisibility.PUBLIC);
  if (!viewerId) return publicReplies;
  return or(
    publicReplies,
    and(
      eq(posts.visibility, PostVisibility.FOLLOWERS_ONLY),
      inArray(posts.oxyUserId, [viewerId, ...followingIds]),
    ),
    directPostParticipantSql(viewerId),
  ) as SQL;
}

/** One private-mention conversation as the inbox lists it. */
export interface PrivateMentionConversationRow {
  /** The thread root — the conversation's id, and what the thread view opens. */
  rootId: string;
  /** The newest post in it the viewer takes part in. */
  latestPostId: string;
  lastActivityAt: Date;
  /** How many of its posts the viewer takes part in. */
  postCount: number;
}

/**
 * The viewer's private-mention conversations — the direct posts they wrote or
 * were sent, grouped by thread root — newest activity first, keyset-paged on
 * `(lastActivityAt, rootId)` descending.
 *
 * Two indexed arms, never an OR across tables: the viewer's own posts, and the
 * `post_recipients_oxy_user_id_idx` rows naming them. Withheld posts (a draft,
 * a scheduled post) are not conversations yet.
 */
export async function listPrivateMentionConversations(
  viewerId: string,
  options: { limit: number; before?: { lastActivityAt: Date; rootId: string } },
  db: DatabaseOrTransaction = getDb(),
): Promise<PrivateMentionConversationRow[]> {
  const direct = sql`${posts.visibility} = ${PostVisibility.DIRECT} and ${posts.status} = 'published'`;
  const participating = sql`
    select ${posts.id} as id, coalesce(${posts.threadId}, ${posts.id}) as root_id, ${posts.createdAt} as created_at
    from ${posts}
    where ${posts.oxyUserId} = ${viewerId} and ${direct}
    union
    select ${posts.id}, coalesce(${posts.threadId}, ${posts.id}), ${posts.createdAt}
    from ${postRecipients} join ${posts} on ${posts.id} = ${postRecipients.postId}
    where ${postRecipients.oxyUserId} = ${viewerId} and ${direct}`;
  const before = options.before
    ? sql`having (max(created_at), root_id) < (${options.before.lastActivityAt.toISOString()}::timestamptz, ${options.before.rootId})`
    : sql``;
  const rows = await db.execute<{
    root_id: string;
    latest_id: string;
    last_at: Date | string;
    post_count: number;
  }>(sql`
    select root_id,
      (array_agg(id order by created_at desc, id desc))[1] as latest_id,
      max(created_at) as last_at,
      count(*)::int as post_count
    from (${participating}) as participating
    group by root_id
    ${before}
    order by last_at desc, root_id desc
    limit ${options.limit}`);
  return [...rows].map((row) => ({
    rootId: row.root_id,
    latestPostId: row.latest_id,
    lastActivityAt: new Date(row.last_at),
    postCount: Number(row.post_count),
  }));
}

/**
 * Turn a stored post into a private mention addressed to `recipients` — only
 * while it still has the visibility the caller read (`from`), so a concurrent
 * change is never overwritten. Returns whether it changed. The caller
 * invalidates the record cache.
 */
export async function convertToDirectPost(
  postId: string,
  from: PostVisibility,
  recipients: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const write = async (tx: DatabaseOrTransaction): Promise<boolean> => {
    const updated = await tx
      .update(posts)
      .set({ visibility: PostVisibility.DIRECT })
      .where(and(eq(posts.id, postId), eq(posts.visibility, from)))
      .returning({ id: posts.id });
    if (updated.length === 0) return false;
    await insertPostRecipients(postId, recipients, tx);
    return true;
  };
  return 'transaction' in db ? db.transaction(write) : write(db);
}
