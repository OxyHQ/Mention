/**
 * "How many people in your network engaged with this post" — the `socialProof`
 * ranking signal.
 *
 * This module had NO test at all, which is how it kept two independent ways of
 * losing the same rows: it read likes from the Mongo `Like` collection, which
 * nothing has written since engagement moved to Postgres, and it first narrowed
 * the candidate ids with `mongoose.isValidObjectId` — a filter that discards
 * every post minted since the cutover, because `posts.id` is `text` holding
 * ObjectId hex before it and uuid v7 after. Both failures are silent: the signal
 * simply reads lower, and a ranking signal that reads lower looks like a quiet
 * network rather than a bug.
 *
 * Real rows throughout. The boost half already queried Postgres, so mocking here
 * would have hidden the very asymmetry that made the like half wrong.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PostType } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { likes } from '../../db/schema/engagement';
import { getNetworkEngagerCounts } from '../../services/networkEngagement';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('network-engagement');
const AUTHOR = scope.user('author');
const FRIEND_A = scope.user('friend-a');
const FRIEND_B = scope.user('friend-b');
const STRANGER = scope.user('stranger');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb()
    .delete(likes)
    .where(inArray(likes.userId, [FRIEND_A, FRIEND_B, STRANGER]));
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('getNetworkEngagerCounts', () => {
  it('counts a like from someone in the network', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    await getDb().insert(likes).values({ userId: FRIEND_A, postId: post.id, value: 1 });

    const counts = await getNetworkEngagerCounts([post.id], [FRIEND_A, FRIEND_B]);

    expect(counts.get(post.id)).toBe(1);
  });

  it('counts a post id that is not ObjectId-shaped', async () => {
    // The regression the removed shape check caused. `seedPost` mints a uuid, so
    // this is the id shape every post created since the cutover carries — and
    // the old `isValidObjectId` filter dropped it before the query ran.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    expect(post.id).not.toMatch(/^[0-9a-f]{24}$/);
    await getDb().insert(likes).values({ userId: FRIEND_A, postId: post.id, value: 1 });

    const counts = await getNetworkEngagerCounts([post.id], [FRIEND_A]);

    expect(counts.get(post.id)).toBe(1);
  });

  it('counts one person once when they both like and boost', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    await getDb().insert(likes).values({ userId: FRIEND_A, postId: post.id, value: 1 });
    await seedPost(scope, {
      oxyUserId: FRIEND_A,
      type: PostType.BOOST,
      boostOf: post.id,
      content: { variants: [{ source: 'author', text: '', tag: 'en' }] },
    });

    const counts = await getNetworkEngagerCounts([post.id], [FRIEND_A]);

    // The distinct-engager guarantee: a Set collapses the two into one person.
    expect(counts.get(post.id)).toBe(1);
  });

  it('ignores engagement from outside the network', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    await getDb().insert(likes).values([
      { userId: FRIEND_A, postId: post.id, value: 1 },
      { userId: STRANGER, postId: post.id, value: 1 },
    ]);

    const counts = await getNetworkEngagerCounts([post.id], [FRIEND_A]);

    // Positive and negative in one case: the friend is counted, the stranger is
    // not — so a reader that ignored its engager filter would fail here rather
    // than pass on an assertion about absence alone.
    expect(counts.get(post.id)).toBe(1);
  });

  it('returns an empty map when there is nothing to aggregate', async () => {
    expect((await getNetworkEngagerCounts([], ['someone'])).size).toBe(0);
    expect((await getNetworkEngagerCounts(['some-post'], [])).size).toBe(0);
  });
});
