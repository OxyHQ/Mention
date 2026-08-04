/**
 * `threadgates` / `postgates` against real rows.
 *
 * These six routes had NO coverage at all under Mongoose, so nothing here went
 * vacuous when the models were ported — there was nothing to go vacuous. The
 * suite exists because a port with no coverage is the shape that ships broken,
 * and because two of the properties below are NEW and only expressible in
 * Postgres:
 *
 *  - **A rule keeps its row.** `allow[]` was a subdocument array Mongo rewrote
 *    wholesale on every `findOneAndUpdate`. It is a child table now, so
 *    delete-then-insert would hand every surviving rule a new id on each edit.
 *    The write upserts by POSITION and deletes only the tail the new list does
 *    not reach, and the assertion is on the row ID, which is the only thing that
 *    can tell the two implementations apart.
 *  - **`(type = 'listOnly') = (list is not null)`** was unenforceable in Mongo,
 *    so a `listOnly` rule matching nobody was storable and silent. The CHECK
 *    refuses it; `parseThreadgateAllowRules` refuses it FIRST so the route can
 *    answer 400 rather than letting a constraint violation read as a 500.
 *
 * Every fixture id carries a per-file prefix: one database serves the whole run
 * and `post_uri` is globally unique, so a literal would collide with whatever a
 * sibling file happened to write.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postgates, threadgateAllowRules, threadgates } from '../../db/schema/gates';
import {
  deletePostgate,
  deleteThreadgate,
  loadPostgateByPostId,
  loadThreadgateByPostId,
  parseDetachedQuoteUris,
  parseThreadgateAllowRules,
  upsertPostgate,
  upsertThreadgate,
} from '../../db/gates/gateRepository';

/** This file's private namespace — see the docblock. */
const NS = 'gate-repo-test';
const AUTHOR = `${NS}-author`;
const OTHER_AUTHOR = `${NS}-other`;

/** A post id no other file can mint. */
function postId(): string {
  return `${NS}-${randomUUID()}`;
}

/** The MTN URI shape `routes/posts.ts` mints, which embeds the WRITER's id. */
function postUri(writer: string, id: string): string {
  return `mtn://${writer}/app.mention.feed.post/${id}`;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  const db = getDb();
  await db.delete(threadgates).where(like(threadgates.postId, `${NS}-%`));
  await db.delete(postgates).where(like(postgates.postId, `${NS}-%`));
});

afterAll(async () => {
  await closePostgres();
});

/** The rule rows as stored, position order, with their ids. */
async function storedRules(threadgateId: string) {
  return getDb()
    .select({
      id: threadgateAllowRules.id,
      position: threadgateAllowRules.position,
      type: threadgateAllowRules.type,
      listId: threadgateAllowRules.listId,
    })
    .from(threadgateAllowRules)
    .where(eq(threadgateAllowRules.threadgateId, threadgateId))
    .orderBy(threadgateAllowRules.position);
}

describe('threadgates', () => {
  it('stores the allow rules in order and reads them back by post id', async () => {
    const id = postId();
    const written = await upsertThreadgate({
      postUri: postUri(AUTHOR, id),
      postId: id,
      createdBy: AUTHOR,
      allow: [{ type: 'followingOnly' }, { type: 'listOnly', list: 'list-42' }],
    });

    const read = await loadThreadgateByPostId(id);
    expect(read?.id).toBe(written.id);
    expect(read?.allow).toEqual([{ type: 'followingOnly' }, { type: 'listOnly', list: 'list-42' }]);
    expect(read?.createdBy).toBe(AUTHOR);
  });

  it('replaces the rule list on a re-upsert and KEEPS the surviving rule row', async () => {
    const id = postId();
    const uri = postUri(AUTHOR, id);
    const first = await upsertThreadgate({
      postUri: uri,
      postId: id,
      createdBy: AUTHOR,
      allow: [{ type: 'followingOnly' }, { type: 'followerOnly' }, { type: 'mentionedOnly' }],
    });
    const before = await storedRules(first.id);
    expect(before).toHaveLength(3);

    const second = await upsertThreadgate({
      postUri: uri,
      postId: id,
      createdBy: AUTHOR,
      allow: [{ type: 'followingOnly' }],
    });

    // Same gate — an upsert on `post_uri`, not a second row.
    expect(second.id).toBe(first.id);
    const after = await storedRules(first.id);
    expect(after.map((rule) => rule.type)).toEqual(['followingOnly']);
    // THE assertion: position 0 is the row it always was. A wholesale replace
    // would leave a rule that looks identical under a brand new id.
    expect(after[0].id).toBe(before[0].id);
  });

  it('rewrites a surviving position in place rather than appending beside it', async () => {
    const id = postId();
    const uri = postUri(AUTHOR, id);
    const first = await upsertThreadgate({
      postUri: uri,
      postId: id,
      createdBy: AUTHOR,
      allow: [{ type: 'followingOnly' }],
    });
    const [originalRule] = await storedRules(first.id);

    await upsertThreadgate({
      postUri: uri,
      postId: id,
      createdBy: AUTHOR,
      allow: [{ type: 'listOnly', list: 'list-7' }],
    });

    const after = await storedRules(first.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(originalRule.id);
    expect(after[0]).toMatchObject({ type: 'listOnly', listId: 'list-7' });
  });

  it('returns the OLDEST gate when two writers gated the same post', async () => {
    // `post_uri` embeds the writer, so two people gating one post produce two
    // rows and `post_id` is not unique. Mongo's `findOne` answered arbitrarily.
    const id = postId();
    const mine = await upsertThreadgate({
      postUri: postUri(AUTHOR, id),
      postId: id,
      createdBy: AUTHOR,
      allow: [{ type: 'followingOnly' }],
    });
    await upsertThreadgate({
      postUri: postUri(OTHER_AUTHOR, id),
      postId: id,
      createdBy: OTHER_AUTHOR,
      allow: [{ type: 'followerOnly' }],
    });

    expect((await loadThreadgateByPostId(id))?.id).toBe(mine.id);
    expect((await loadThreadgateByPostId(id))?.id).toBe(mine.id);
  });

  it('takes its rules with it when deleted', async () => {
    const id = postId();
    const gate = await upsertThreadgate({
      postUri: postUri(AUTHOR, id),
      postId: id,
      createdBy: AUTHOR,
      allow: [{ type: 'listOnly', list: 'list-1' }],
    });
    expect(await storedRules(gate.id)).toHaveLength(1);

    await deleteThreadgate(gate.id);

    expect(await loadThreadgateByPostId(id)).toBeNull();
    expect(await storedRules(gate.id)).toHaveLength(0);
  });

  it('reads back an empty allow list as a gate that exists with no rules', async () => {
    const id = postId();
    await upsertThreadgate({
      postUri: postUri(AUTHOR, id),
      postId: id,
      createdBy: AUTHOR,
      allow: [],
    });

    const read = await loadThreadgateByPostId(id);
    expect(read).not.toBeNull();
    expect(read?.allow).toEqual([]);
  });
});

describe('parseThreadgateAllowRules', () => {
  it('accepts an absent payload as no rules', () => {
    expect(parseThreadgateAllowRules(undefined)).toEqual([]);
    expect(parseThreadgateAllowRules(null)).toEqual([]);
  });

  it('refuses a listOnly rule with no list — it would match nobody, silently', () => {
    expect(parseThreadgateAllowRules([{ type: 'listOnly' }])).toBeNull();
    expect(parseThreadgateAllowRules([{ type: 'listOnly', list: '' }])).toBeNull();
  });

  it('refuses a list on a rule that is not listOnly', () => {
    expect(parseThreadgateAllowRules([{ type: 'followingOnly', list: 'list-1' }])).toBeNull();
  });

  it('refuses an unknown rule type and a non-array payload', () => {
    expect(parseThreadgateAllowRules([{ type: 'everyone' }])).toBeNull();
    expect(parseThreadgateAllowRules([{ list: 'list-1' }])).toBeNull();
    expect(parseThreadgateAllowRules(['followingOnly'])).toBeNull();
    expect(parseThreadgateAllowRules({ type: 'followingOnly' })).toBeNull();
  });

  it('accepts the four legal rule shapes', () => {
    expect(
      parseThreadgateAllowRules([
        { type: 'mentionedOnly' },
        { type: 'followingOnly' },
        { type: 'followerOnly' },
        { type: 'listOnly', list: 'list-1' },
      ]),
    ).toEqual([
      { type: 'mentionedOnly' },
      { type: 'followingOnly' },
      { type: 'followerOnly' },
      { type: 'listOnly', list: 'list-1' },
    ]);
  });
});

describe('postgates', () => {
  it('round-trips the quote controls and replaces them on a re-upsert', async () => {
    const id = postId();
    const uri = postUri(AUTHOR, id);
    const first = await upsertPostgate({
      postUri: uri,
      postId: id,
      createdBy: AUTHOR,
      disableQuotes: true,
      detachedQuoteUris: ['mtn://a/app.mention.feed.post/1'],
    });
    expect(await loadPostgateByPostId(id)).toMatchObject({
      disableQuotes: true,
      detachedQuoteUris: ['mtn://a/app.mention.feed.post/1'],
    });

    const second = await upsertPostgate({
      postUri: uri,
      postId: id,
      createdBy: AUTHOR,
      disableQuotes: false,
      detachedQuoteUris: [],
    });

    expect(second.id).toBe(first.id);
    expect(await loadPostgateByPostId(id)).toMatchObject({
      disableQuotes: false,
      detachedQuoteUris: [],
    });
  });

  it('is gone after a delete', async () => {
    const id = postId();
    const gate = await upsertPostgate({
      postUri: postUri(AUTHOR, id),
      postId: id,
      createdBy: AUTHOR,
      disableQuotes: true,
      detachedQuoteUris: [],
    });

    await deletePostgate(gate.id);

    expect(await loadPostgateByPostId(id)).toBeNull();
  });
});

describe('parseDetachedQuoteUris', () => {
  it('accepts an absent payload as an empty list', () => {
    expect(parseDetachedQuoteUris(undefined)).toEqual([]);
    expect(parseDetachedQuoteUris(null)).toEqual([]);
  });

  it('refuses anything that is not an array of strings', () => {
    expect(parseDetachedQuoteUris('mtn://a/b/c')).toBeNull();
    expect(parseDetachedQuoteUris([1, 2])).toBeNull();
    expect(parseDetachedQuoteUris([{ uri: 'x' }])).toBeNull();
  });
});
