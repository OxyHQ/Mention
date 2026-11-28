/**
 * `backfillUpstreamPostKeys` keys the posts a keyed transport delivered before
 * their upstream key was written. It walks EVERY keyed transport actor, so this
 * file runs against its own database (`isolatedDatabaseFiles.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { federatedActors, postSourceKeys } from '../../db/schema';
import { insertPostRecord } from '../../db/posts/postRepository';
import { backfillUpstreamPostKeys } from '../../scripts/backfillUpstreamPostKeys';

const ACTOR = 'https://bird.makeup/users/keybackfill';
const OWNER = 'oxy-keybackfill-owner';

async function bridgePost(statusId: string): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: `post ${statusId}`, tag: 'en' }] },
    federation: { activityId: `${ACTOR}/statuses/${statusId}`, actorUri: ACTOR },
  });
  return record.id;
}

async function keyOf(postId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ key: postSourceKeys.sourceKey })
    .from(postSourceKeys)
    .where(eq(postSourceKeys.postId, postId));
  return row?.key;
}

beforeAll(async () => {
  await connectPostgres();
  await getDb().insert(federatedActors).values({
    protocol: 'activitypub',
    uri: ACTOR,
    username: 'keybackfill',
    domain: 'bird.makeup',
    acct: 'keybackfill@bird.makeup',
    networkAcct: 'keybackfill@x.com',
    type: 'Service',
    oxyUserId: OWNER,
    lastFetchedAt: new Date(),
  });
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillUpstreamPostKeys', () => {
  it('counts without writing on a dry run, then keys the posts and reports a key held elsewhere', async () => {
    const legacy = await bridgePost('101');
    const taken = await bridgePost('102');
    const holder = await bridgePost('9102');
    await getDb().insert(postSourceKeys).values({ sourceKey: 'x:102', postId: holder });

    expect(await backfillUpstreamPostKeys({ dryRun: true, pauseMs: 0 })).toMatchObject({
      candidates: 2,
      written: 0,
    });
    expect(await keyOf(legacy)).toBeUndefined();

    expect(await backfillUpstreamPostKeys({ dryRun: false, pauseMs: 0 })).toMatchObject({
      candidates: 2,
      written: 1,
      conflicts: 1,
    });
    expect(await keyOf(legacy)).toBe('x:101');
    expect(await keyOf(taken)).toBeUndefined();
  });
});
