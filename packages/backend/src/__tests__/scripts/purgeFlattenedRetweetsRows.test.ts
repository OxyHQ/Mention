/**
 * `purgeFlattenedRetweets` against REAL ROWS.
 *
 * This script DELETES production posts and there is no soft-delete to undo it
 * with, so what these cases pin is not "does it work" but "what can it possibly
 * touch". Two terms stand between it and a real post, and each has a case that
 * reds if it is removed: the author must be on a REVIEWED BRIDGE, and the body
 * must satisfy the INGEST PREDICATE rather than a lookalike regex.
 *
 * The asymmetry is the predicate's own: a missed retweet stores exactly what we
 * store today, while a false match destroys somebody's post.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { federatedActors } from '../../db/schema/federation';
import { insertPostRecord } from '../../db/posts/postRepository';
import { purgeFlattenedRetweets } from '../../scripts/purgeFlattenedRetweets';
import { FEDERATION_BRIDGE_POLICY } from '../../connectors/activitypub/federationBridgePolicy';

/** A host the INGEST gate really treats as a bridge — read, not invented. */
const BRIDGE_HOST = FEDERATION_BRIDGE_POLICY[0].host;
const ORDINARY_HOST = 'ordinary-instance.test';

const createdPosts: string[] = [];
const createdActors: string[] = [];

async function seedActorOn(host: string, local: string): Promise<string> {
  const oxyUserId = `purge-rt-${local}`;
  await getDb().insert(federatedActors).values({
    uri: `https://${host}/users/${local}`,
    username: local,
    domain: host,
    acct: `${local}@${host}`,
    oxyUserId,
  });
  createdActors.push(oxyUserId);
  return oxyUserId;
}

async function seedPost(oxyUserId: string, body: string): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId,
    authorship: [{ oxyUserId, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: body }] },
    federation: { activityId: `https://purge.test/notes/${createdPosts.length + 1}` },
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
    await getDb().delete(posts).where(inArray(posts.id, [...createdPosts]));
    createdPosts.length = 0;
  }
  if (createdActors.length > 0) {
    await getDb().delete(federatedActors).where(inArray(federatedActors.oxyUserId, [...createdActors]));
    createdActors.length = 0;
  }
});

describe('purgeFlattenedRetweets', () => {
  it('deletes a flattened retweet on a reviewed bridge', async () => {
    const author = await seedActorOn(BRIDGE_HOST, 'bridged');
    const postId = await seedPost(author, 'RT: @ThomasitaD BUENAVENTURA NECESITA MÉDICOS');

    const result = await purgeFlattenedRetweets({ dryRun: false });

    expect(await exists(postId)).toBe(false);
    expect(result.deleted).toBe(1);
    expect(result.noOpWrites).toBe(false);
  });

  it('SPARES the same body from an ordinary instance', async () => {
    // The host gate, and the case that reds if the bridge join is dropped. A
    // human writing "RT:" is not a bridge artefact and must never be destroyed.
    const author = await seedActorOn(ORDINARY_HOST, 'human');
    const postId = await seedPost(author, 'RT: @someone quoting a friend');

    const result = await purgeFlattenedRetweets({ dryRun: false });

    expect(await exists(postId)).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it('SPARES a bridge post that merely mentions RT without the ingest shape', async () => {
    // The predicate gate. `isBridgeFlattenedRetweet` anchors at position 0 and
    // requires `@` immediately after, so neither of these is a retweet — and a
    // widened regex would destroy both.
    const author = await seedActorOn(BRIDGE_HOST, 'bridged2');
    const midSentence = await seedPost(author, 'talking about an RT: @someone said this');
    const noHandle = await seedPost(author, 'RT: https://example.com/a-link');

    const result = await purgeFlattenedRetweets({ dryRun: false });

    expect(await exists(midSentence)).toBe(true);
    expect(await exists(noHandle)).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it('a DRY RUN reports the work and deletes nothing', async () => {
    const author = await seedActorOn(BRIDGE_HOST, 'bridged3');
    const postId = await seedPost(author, 'RT: @someone the text of the tweet');

    const result = await purgeFlattenedRetweets({ dryRun: true });

    expect(result.matched).toBe(1);
    expect(result.deleted).toBe(0);
    expect(await exists(postId)).toBe(true);
  });
});
