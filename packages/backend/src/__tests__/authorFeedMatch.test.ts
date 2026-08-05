/**
 * What `authorFeedSql` MATCHES — the profile feed's membership rule, against a
 * real database.
 *
 * The rule is "this post is `authorId`'s", and it is answered by two terms:
 * the `post_authorships` `EXISTS` (the authority) OR the denormalized
 * `posts.oxy_user_id` mirror. Every case below exists because ONE of those two
 * terms answers it and the other does not — so a formulation that keeps only one
 * of them fails by naming the post it dropped.
 *
 * That is the whole point of the file. The obvious "optimisation" here is to
 * trade the correlated `EXISTS` for the cheap mirror, or to narrow it to
 * `role = 'collaborator'` on the grounds that the mirror already covers owners.
 * Both are measurably faster and both silently DROP rows — which matters more
 * than usual, because the defect this feed was reported for is posts MISSING
 * from their own author's profile. A speedup that loses posts is that bug with a
 * better latency graph.
 *
 * ## These are not invariant assertions, deliberately
 *
 * The mirror is documented (`db/schema/postContent.ts`) as always agreeing with
 * the `owner` authorship row, and an earlier draft of this suite asserted that
 * agreement directly. That test guards the wrong thing: the `or` is a SUPERSET
 * of either term, so it is correct whether or not the invariant holds, and a
 * test that fails when the mirror drifts would report a data condition this code
 * is specifically built to tolerate. What is asserted instead is the property
 * that actually protects the reader — no drift state, in either direction, can
 * cost a post its place on its author's profile.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { authorFeedSql } from '../utils/postAuthorship';

let db: Database;
const created: string[] = [];

const AUTHOR = 'authormatch-author';
const OTHER = 'authormatch-other';
const CHANNEL = 'authormatch-channel';
const WRITER = 'authormatch-writer';

/**
 * Fixtures are stamped in the FUTURE so this suite's rows sort above whatever
 * else the shared database holds, and so their relative order is stated here
 * rather than inherited from insertion timing.
 */
const HORIZON = Date.now() + 60_000;

async function create(overrides: Partial<PostRecordInput>): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OTHER,
    authorship: [{ oxyUserId: OTHER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    createdAt: new Date(HORIZON),
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

/** The ids `authorFeedSql` matches, restricted to this suite's own rows. */
async function matched(authorId: string): Promise<string[]> {
  if (created.length === 0) return [];
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(authorFeedSql(authorId), inArray(posts.id, [...created])));
  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  const ids = created.splice(0);
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('authorFeedSql — which posts count as an author\'s own', () => {
  /**
   * The ordinary shape, and the two DRIFT shapes that only the `EXISTS` can
   * answer. Both drift rows are states the schema permits: `oxy_user_id` is
   * nullable (the raw federated insert path may omit it) and Mongo's owner-mirror
   * hook was bypassed by bulk writes, so backfilled rows can carry a stale one.
   *
   * Mutation: narrow the `EXISTS` to `role = 'collaborator'` — the shape that
   * measured fastest — and this goes red naming `nullMirror` and `staleMirror`.
   */
  it('serves posts whose authorship row exists but whose mirror is absent or stale', async () => {
    const ordinary = await create({
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });
    // Owner authorship present, mirror never written.
    const nullMirror = await create({
      oxyUserId: null,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });
    // Owner authorship present, mirror points at somebody else.
    const staleMirror = await create({
      oxyUserId: OTHER,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });

    expect(await matched(AUTHOR)).toEqual([ordinary, nullMirror, staleMirror].sort());
  });

  /**
   * The shape only the MIRROR can answer, and the one that makes this a
   * correctness fix rather than an optimisation: `insertChildRows` writes
   * authorship rows only `if (authorship.length > 0)`, so a post created with an
   * empty authorship list has an owner and no `post_authorships` row at all.
   * Under the `EXISTS` alone it is invisible on its own author's profile.
   *
   * Mutation: drop the `oxy_user_id` term and this goes red naming `noAuthorship`.
   */
  it('serves a post that carries an owner but no authorship row at all', async () => {
    const noAuthorship = await create({ oxyUserId: AUTHOR, authorship: [] });

    expect(await matched(AUTHOR)).toEqual([noAuthorship]);
  });

  /**
   * Consent. A collaborator counts once they have ACCEPTED and never before —
   * an invitee must not appear as an author, and must not have the invitation
   * disclosed by the post surfacing on their profile.
   *
   * The mirror cannot leak a pending invite (it holds the owner), so this is the
   * `EXISTS`'s `status` term being load-bearing. Mutation: drop
   * `status = 'accepted'` and this goes red naming `pendingCollab`.
   */
  it('serves accepted collaborators and withholds pending ones', async () => {
    const acceptedCollab = await create({
      oxyUserId: OTHER,
      authorship: [
        { oxyUserId: OTHER, role: 'owner', status: 'accepted' },
        { oxyUserId: AUTHOR, role: 'collaborator', status: 'accepted' },
      ],
    });
    await create({
      oxyUserId: OTHER,
      authorship: [
        { oxyUserId: OTHER, role: 'owner', status: 'accepted' },
        { oxyUserId: AUTHOR, role: 'collaborator', status: 'pending' },
      ],
    });

    expect(await matched(AUTHOR)).toEqual([acceptedCollab]);
  });

  /**
   * A channel post belongs to the CHANNEL, never to the human who typed it.
   * `utils/postAuthorship` calls that exclusion load-bearing and explains it is
   * held by `written_by_oxy_user_id` being a column these matchers never read —
   * so adding a term that reads `oxy_user_id` is exactly the change that could
   * have broken it, and it does not, because `oxy_user_id` holds the channel.
   *
   * Asserted rather than reasoned about: this is the property that would fail
   * silently and publicly, by republishing on a writer's profile the posts a
   * channel exists to keep anonymous.
   */
  it('keeps a channel post on the channel and off its writer', async () => {
    const channelPost = await create({
      oxyUserId: CHANNEL,
      writtenByOxyUserId: WRITER,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
    });

    expect(await matched(CHANNEL)).toEqual([channelPost]);
    expect(await matched(WRITER)).toEqual([]);
  });

  /**
   * The negative case that keeps the three positives honest: nothing belonging
   * to somebody else is served. Without this, a predicate that simply matched
   * everything would pass every assertion above.
   */
  it('serves nothing belonging to another account', async () => {
    await create({
      oxyUserId: OTHER,
      authorship: [{ oxyUserId: OTHER, role: 'owner', status: 'accepted' }],
    });

    expect(await matched(AUTHOR)).toEqual([]);
  });
});
