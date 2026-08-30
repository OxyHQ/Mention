/**
 * WHAT A CHANNEL DELETION IS POINTED AT — the post batches it walks, and the
 * account-scoped counts a preview states.
 *
 * Strictly read-only. Nothing here deletes anything: it resolves what the run
 * will affect, which is why `previewChannelDeletion` and the dry run share
 * it unchanged.
 *
 * The batch is where `posts.boost_of`'s SELF-cascade is dealt with. Deleting a
 * channel post deletes every boost of it, transitively, inside the same
 * statement — so the closure is captured BEFORE the delete, while the links are
 * still live, and handed on whole.
 */

import { and, count, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { qualified } from '@oxyhq/db';
import { posts } from '../../db/schema/posts';
import { postAuthorships } from '../../db/schema/postContent';
import { federatedFollows } from '../../db/schema/federation';
import type { PostDeletionTarget } from '../../scripts/lib/adminDeletionPreflight';
import type { CascadedPostRow } from '../PostDeletionCascade';
import { LOG_PREFIX } from './channelCascadeLog';

/**
 * How many of the channel's own posts one batch takes.
 *
 * Bounds three things at once: the `IN` list every post-scoped leg builds, the
 * size of one transaction, and the memory the boost closure can reach. It is not
 * a limit on how much can be deleted — the loop runs until the channel has no
 * posts left — so there is no size at which an operator has to intervene.
 */
export const POST_BATCH_SIZE = 200;

/**
 * How far one batch's boost closure may expand before the run is REFUSED.
 *
 * The closure is unbounded in principle: a widely boosted post has as many boosts
 * as it has boosters. Past this the batch is refused rather than committed
 * half-captured, because a partially captured closure means boost rows the
 * database deletes whose polymorphic references nothing was left to find — the
 * exact orphan the capture exists to prevent. An operator hears about it; a
 * silent truncation would not be a smaller version of this, it would be the bug.
 */
export const MAX_BOOST_CLOSURE_PER_BATCH = 5_000;

/** The columns the delegate reads off a post, plus the two only this cascade needs. */
const CASCADE_ROW_COLUMNS = {
  id: posts.id,
  oxyUserId: posts.oxyUserId,
  parentPostId: posts.parentPostId,
  federationActivityId: posts.federationActivityId,
  federationUrl: posts.federationUrl,
} as const;

/** A channel post, plus what decides whether a remote server was ever told about it. */
const CHANNEL_ROW_COLUMNS = {
  ...CASCADE_ROW_COLUMNS,
  visibility: posts.visibility,
  status: posts.status,
  boostOf: posts.boostOf,
  writtenByOxyUserId: posts.writtenByOxyUserId,
} as const;

/**
 * A post belongs to the channel by the denormalized owner cache OR by its
 * authorship owner entry.
 *
 * The two are kept in sync by the write path, but a cascade is the wrong place to
 * depend on that having held for every row — and unlike Mongo's `$elemMatch` this
 * is a real join, so the authorship half costs an index lookup rather than a
 * document scan.
 */
function ownedByChannel(channelOxyUserId: string): SQL {
  const byAuthorship = sql`exists (select 1 from ${postAuthorships} where ${qualified(postAuthorships.postId)} = ${qualified(posts.id)} and ${qualified(postAuthorships.oxyUserId)} = ${channelOxyUserId} and ${qualified(postAuthorships.role)} = 'owner')`;
  return sql`(${eq(posts.oxyUserId, channelOxyUserId)} or ${byAuthorship})`;
}

/** The AP identifiers a post additionally travels under. */
function postUris(row: Pick<CascadedPostRow, 'federationActivityId' | 'federationUrl'>): string[] {
  return [row.federationActivityId, row.federationUrl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/** Raised when one batch's boost closure exceeds {@link MAX_BOOST_CLOSURE_PER_BATCH}. */
export class ChannelBoostClosureTooLargeError extends Error {
  constructor(
    readonly channelOxyUserId: string,
    readonly found: number,
  ) {
    super(
      `${LOG_PREFIX} refused to expand the boost closure for ${channelOxyUserId}: one batch reaches ` +
        `more than ${MAX_BOOST_CLOSURE_PER_BATCH} boosts. Capturing a prefix of it would leave boost ` +
        'rows the database deletes whose own references nothing could find, so this needs an operator ' +
        'rather than a retry.',
    );
    this.name = 'ChannelBoostClosureTooLargeError';
  }
}

/** One batch of the channel's posts, and every boost that dies with them. */
export interface PostBatch {
  /** The channel's own posts in this batch, in keyset order. */
  readonly channelPosts: readonly ChannelPostRow[];
  /** Other people's boosts of them, transitively, captured while the links are live. */
  readonly boosts: readonly CascadedPostRow[];
  /** Both, in the shape the delegate and the preflight read. */
  readonly rows: readonly CascadedPostRow[];
  /** The keyset position to resume from. */
  readonly lastId: string;
}

export interface ChannelPostRow extends CascadedPostRow {
  visibility: string;
  status: string;
  boostOf: string | null;
  writtenByOxyUserId: string | null;
}

/** Everything the account-scoped steps filter on, resolved once, read-only. */
export interface DeletionTargets {
  readonly channelOxyUserId: string;
  /** Remote inboxes a `Delete(actor)` would reach. */
  readonly federatedFollowers: number;
  /** The channel's own posts. */
  readonly posts: number;
  /** Other people's boosts of them. */
  readonly boostsByOthers: number;
  /** Other people's replies into the set — expected to be 0. */
  readonly repliesByOthers: number;
  /** Other people's quotes of a doomed post; kept, pointer cleared by the FK. */
  readonly quotesByOthersKept: number;
}

/**
 * Read the channel's next batch of posts and the boost closure that dies with
 * them.
 *
 * The closure is expanded TRANSITIVELY, because `boost_of` can name a boost and a
 * boost of a boost is still a card with nothing behind it — the database removes
 * it either way, which is exactly why it must be captured.
 */
export async function readPostBatch(
  channelOxyUserId: string,
  after: string | null,
): Promise<PostBatch | null> {
  const db = getDb();
  const channelPosts = await db
    .select(CHANNEL_ROW_COLUMNS)
    .from(posts)
    .where(after === null ? ownedByChannel(channelOxyUserId) : and(ownedByChannel(channelOxyUserId), gt(posts.id, after)))
    .orderBy(posts.id)
    .limit(POST_BATCH_SIZE);

  if (channelPosts.length === 0) return null;

  const seen = new Set(channelPosts.map((row) => row.id));
  const boosts: CascadedPostRow[] = [];
  let frontier = [...seen];

  while (frontier.length > 0) {
    const next = await db
      .select(CASCADE_ROW_COLUMNS)
      .from(posts)
      .where(inArray(posts.boostOf, frontier))
      .limit(MAX_BOOST_CLOSURE_PER_BATCH + 1);

    frontier = [];
    for (const boost of next) {
      if (seen.has(boost.id)) continue;
      seen.add(boost.id);
      boosts.push(boost);
      frontier.push(boost.id);
    }
    if (boosts.length > MAX_BOOST_CLOSURE_PER_BATCH) {
      throw new ChannelBoostClosureTooLargeError(channelOxyUserId, boosts.length);
    }
  }

  return {
    channelPosts,
    boosts,
    rows: [...channelPosts, ...boosts],
    lastId: channelPosts[channelPosts.length - 1].id,
  };
}

/** The preflight's view of a captured batch. */
export function deletionTargetsOf(rows: readonly CascadedPostRow[]): PostDeletionTarget[] {
  return rows.map((row) => ({ id: row.id, uris: postUris(row) }));
}

/** Every key a batch's posts can be named by: their ids plus their AP identifiers. */
export function postKeysOf(rows: readonly CascadedPostRow[]): string[] {
  return [...new Set([...rows.map((row) => row.id), ...rows.flatMap(postUris)])];
}

/**
 * Read the account-scoped id sets and the counts a preview states. Strictly
 * read-only, so `previewChannelDeletion` and the dry run share it unchanged.
 */
export async function resolveDeletionTargets(channelOxyUserId: string): Promise<DeletionTargets> {
  const db = getDb();
  const owned = ownedByChannel(channelOxyUserId);
  const channelPostIds = db.select({ id: posts.id }).from(posts).where(owned);

  const [[postCount], [boostCount], [replyCount], [quoteCount], [followerCount]] =
    await Promise.all([
      db.select({ n: count() }).from(posts).where(owned),
      // Boosts of a channel post that are NOT themselves the channel's — the rows
      // the FK destroys alongside, which is what a person confirming needs told.
      db
        .select({ n: count() })
        .from(posts)
        .where(and(inArray(posts.boostOf, channelPostIds), sql`not (${owned})`)),
      db
        .select({ n: count() })
        .from(posts)
        .where(and(inArray(posts.parentPostId, channelPostIds), sql`not (${owned})`)),
      db
        .select({ n: count() })
        .from(posts)
        .where(and(inArray(posts.quoteOf, channelPostIds), sql`not (${owned})`)),
      db
        .select({ n: count() })
        .from(federatedFollows)
        .where(
          and(
            eq(federatedFollows.localUserId, channelOxyUserId),
            eq(federatedFollows.direction, 'inbound'),
            eq(federatedFollows.status, 'accepted'),
          ),
        ),
    ]);

  return {
    channelOxyUserId,
    federatedFollowers: followerCount.n,
    posts: postCount.n,
    boostsByOthers: boostCount.n,
    repliesByOthers: replyCount.n,
    quotesByOthersKept: quoteCount.n,
  };
}
