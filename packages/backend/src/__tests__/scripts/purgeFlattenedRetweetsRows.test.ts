/**
 * `purgeFlattenedRetweets` against REAL ROWS.
 *
 * This script DELETES production posts and there is no soft-delete to undo it
 * with, so what these cases pin is not "does it work" but "what can it possibly
 * touch". Two terms stand between it and a real post, and each has a case that
 * reds if it is removed: the post must come from a REVIEWED BRIDGE, and the body
 * must satisfy the INGEST DECISION rather than a lookalike regex.
 *
 * A missed retweet leaves a post under the wrong byline; a false match destroys
 * somebody's post.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { insertPostRecord } from '../../db/posts/postRepository';
import { purgeFlattenedRetweets } from '../../scripts/purgeFlattenedRetweets';
import { REVIEWED_REPOST_TRANSPORT_HOSTS } from '../../connectors/activitypub/repostTransportPolicy';

/** A host the INGEST gate really treats as a bridge — read, not invented. */
const BRIDGE_HOST = REVIEWED_REPOST_TRANSPORT_HOSTS[0];
const ORDINARY_HOST = 'ordinary-instance.test';

const createdPosts: string[] = [];

/** A federated post stored from `host`, stamped with its actor as ingest stamps it. */
async function seedPost(host: string, body: string): Promise<string> {
  const actorUri = `https://${host}/users/someone`;
  const record = await insertPostRecord({
    oxyUserId: 'purge-rt-author',
    authorship: [{ oxyUserId: 'purge-rt-author', role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: body }] },
    federation: { activityId: `${actorUri}/statuses/${createdPosts.length + 1}`, actorUri },
  });
  createdPosts.push(record.id);
  return record.id;
}

async function exists(postId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: posts.id }).from(posts).where(eq(posts.id, postId));
  return row !== undefined;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  if (createdPosts.length > 0) {
    await getDb()
      .delete(posts)
      .where(inArray(posts.id, [...createdPosts]));
    createdPosts.length = 0;
  }
});

describe('purgeFlattenedRetweets', () => {
  it('deletes a flattened retweet on a reviewed bridge, its tagged author stored as a placeholder too', async () => {
    // The second is the shape the old gate missed: the bridge tagged the
    // original author, so the stored body opens with the resolved mention.
    const bare = await seedPost(BRIDGE_HOST, 'RT: @someone the text of the tweet');
    const tagged = await seedPost(BRIDGE_HOST, 'RT: [mention:abc123] the text of the tweet');

    const result = await purgeFlattenedRetweets({ dryRun: false });

    expect(await exists(bare)).toBe(false);
    expect(await exists(tagged)).toBe(false);
    expect(result.deleted).toBe(2);
    expect(result.matchedByHost).toEqual({ [BRIDGE_HOST]: 2 });
  });

  it('SPARES the same body from an ordinary instance', async () => {
    // The host gate. A human writing "RT:" is not a bridge artefact and must
    // never be destroyed.
    const postId = await seedPost(ORDINARY_HOST, 'RT: @someone quoting a friend');

    const result = await purgeFlattenedRetweets({ dryRun: false });

    expect(await exists(postId)).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it('SPARES a bridge post that merely mentions RT without the ingest shape', async () => {
    // The predicate gate: the marker is anchored at position 0 and needs a
    // mention right after it, so neither of these is a retweet.
    const midSentence = await seedPost(BRIDGE_HOST, 'talking about an RT: @someone said this');
    const noHandle = await seedPost(BRIDGE_HOST, 'RT: https://example.com/a-link');

    const result = await purgeFlattenedRetweets({ dryRun: false });

    expect(await exists(midSentence)).toBe(true);
    expect(await exists(noHandle)).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it('a DRY RUN reports the work and deletes nothing', async () => {
    const postId = await seedPost(BRIDGE_HOST, 'RT: @someone the text of the tweet');

    const result = await purgeFlattenedRetweets({ dryRun: true });

    expect(result.matched).toBe(1);
    expect(result.deleted).toBe(0);
    expect(await exists(postId)).toBe(true);
  });
});
