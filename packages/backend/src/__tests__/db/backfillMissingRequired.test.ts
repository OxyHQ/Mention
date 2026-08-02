/**
 * The missing-required probe — and the difference between a field of the
 * DOCUMENT and a field of an array ELEMENT.
 *
 * `auditMissingRequired` asks "which documents would `buildRow` refuse for a
 * `NOT NULL` column with no default", and a dotted path is not a safe way to ask
 * it. Mongo resolves `content.media.type` against EVERY element at once, so
 * `{$exists:false}` is true for a post with no media at all — a post that emits
 * no `post_media` row and cannot violate anything.
 *
 * Measured against production before this was fixed: SIX findings covering
 * 1,591,772 documents, and zero rows Postgres would have refused. That is not a
 * cosmetic overcount. Every finding BLOCKS the copy, and the defaulted-column
 * and referential-integrity passes run only once nothing blocks, so an inflated
 * count here stops the audit before it produces the report it exists for.
 *
 * The same predicate fails in the other direction too, which is the half that is
 * easy to forget: `$exists:false` is FALSE the moment one element carries the
 * field, so a mixed array — `[{type:'image'}, {}]` — read as clean while its
 * second element was exactly the row that would fail.
 *
 * So the fixtures below are built as a DISCRIMINATING set. Four shapes that
 * emit no row must not be reported; two that would emit a bad row must be. A
 * test that only asserted the true positive would pass against the old code and
 * rebuild the same blind spot.
 *
 * Fixtures are `bmr-` prefixed and every id is scoped to this file — vitest runs
 * files in parallel against one database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { auditEnums } from '../../db/backfill/audit';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { tableName } from '../../db/backfill/plan';
import { posts as postsTable } from '../../db/schema/posts';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

/** The finding naming one audited path, or `undefined` when it was not raised. */
const findingFor = (findings: readonly { detail: string }[], path: string) =>
  findings.find((finding) => finding.detail.startsWith(`posts.${path} is MISSING`));

/**
 * A stable, file-scoped id. An `ObjectId` takes 24 HEX characters, so the `bmr-`
 * prefix this file uses for string fixtures cannot appear in one; the `b`
 * padding is the closest hex equivalent and is what keeps these ids from
 * colliding with another file's.
 */
const id = (suffix: string) => new ObjectId(`bbbbbbbbbbbbbbbbbbbbbb${suffix}`.slice(-24));

/** Every document below carries one, so it is never the thing under test. */
const REPLY_PERMISSION = ['anyone'];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_missing_required_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await mongo.collection('posts').deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('the two questions this probe has to tell apart', () => {
  it('is asking about a CHILD table for the paths that were over-reported', () => {
    // The discriminator is not a guess about the path string — it is which
    // table the value lands in, which the plan states. If a future change moved
    // `post_media.type` onto `posts`, the audit would (correctly) go back to
    // asking about the document, and this assertion is what says so out loud.
    const plan = planFor('posts');
    const media = plan.enumAudits?.find((audit) => audit.path === 'content.media.type');
    const reply = plan.enumAudits?.find((audit) => audit.path === 'replyPermission');
    expect(media).toBeDefined();
    expect(reply).toBeDefined();
    expect(tableName(media?.column.table ?? postsTable)).toBe('post_media');
    expect(tableName(reply?.column.table ?? postsTable)).toBe(tableName(plan.table));
  });
});

describe('auditMissingRequired, through auditEnums, on an array-nested path', () => {
  it('reports an element that lacks the field and NOTHING that emits no row', async () => {
    await mongo.collection('posts').insertMany([
      // --- the four shapes that emit no `post_media` row ------------------
      // no media key at all — the shape 465,302 production posts have
      { _id: id('a1'), replyPermission: REPLY_PERMISSION, content: { text: 'no media key' } },
      // an empty array — 213,798 in production
      { _id: id('a2'), replyPermission: REPLY_PERMISSION, content: { media: [] } },
      // a NULL where the array should be — ~251,470 in production, and the one
      // shape that is not "an element missing a field" in any reading
      { _id: id('a3'), replyPermission: REPLY_PERMISSION, content: { media: null } },
      // media present and complete
      {
        _id: id('a4'),
        replyPermission: REPLY_PERMISSION,
        content: { media: [{ id: 'bmr-m1', type: 'image' }] },
      },
      // --- the two that WOULD produce a row Postgres refuses --------------
      {
        _id: id('b1'),
        replyPermission: REPLY_PERMISSION,
        content: { media: [{ id: 'bmr-m2' }] },
      },
      // MIXED: the old `$exists:false` was FALSE here, because the first
      // element carries `type`. The second element is still a 23502.
      {
        _id: id('b2'),
        replyPermission: REPLY_PERMISSION,
        content: { media: [{ id: 'bmr-m3', type: 'video' }, { id: 'bmr-m4' }] },
      },
    ]);

    const finding = findingFor(await auditEnums(source, planFor('posts')), 'content.media.type');

    expect(finding).toBeDefined();
    // TWO of six. Not "some document somewhere": the count is what an operator
    // acts on, and it is the number that was wrong by five orders of magnitude.
    expect(finding?.documents).toBe(2);
    expect(finding?.sampleIds.sort()).toEqual([String(id('b1')), String(id('b2'))].sort());
  });

  it('raises NOTHING when every element carries the field', async () => {
    // The false-positive direction on its own, because a gate that cries wolf
    // gets disabled by whoever hits it next — and this one refused a copy of
    // 583,665 correct posts.
    await mongo.collection('posts').insertMany([
      { _id: id('c1'), replyPermission: REPLY_PERMISSION, content: { text: 'plain' } },
      { _id: id('c2'), replyPermission: REPLY_PERMISSION, content: { media: [] } },
      { _id: id('c3'), replyPermission: REPLY_PERMISSION, content: { media: null } },
      {
        _id: id('c4'),
        replyPermission: REPLY_PERMISSION,
        content: { media: [{ id: 'bmr-m5', type: 'gif' }] },
      },
    ]);

    expect(findingFor(await auditEnums(source, planFor('posts')), 'content.media.type')).toBeUndefined();
  });

  it('descends TWO array levels, and stops at the subdocument that is absent', async () => {
    // `content.variants[].media[].type` — the path that reported every post in
    // production, because no document has ever had it. A variant with no media
    // emits no `post_variant_media` row; one whose media lacks a type does.
    await mongo.collection('posts').insertMany([
      {
        _id: id('d1'),
        replyPermission: REPLY_PERMISSION,
        content: { variants: [{ source: 'author' }] },
      },
      {
        _id: id('d2'),
        replyPermission: REPLY_PERMISSION,
        content: { variants: [{ source: 'author', media: [] }] },
      },
      {
        _id: id('d3'),
        replyPermission: REPLY_PERMISSION,
        content: { variants: [{ source: 'machine', media: [{ id: 'bmr-v1' }] }] },
      },
    ]);

    const finding = findingFor(
      await auditEnums(source, planFor('posts')),
      'content.variants.media.type'
    );

    expect(finding?.documents).toBe(1);
    expect(finding?.sampleIds).toEqual([String(id('d3'))]);
  });

  it('raises nothing for a path no document has ever held', async () => {
    // Production's actual state for `content.variants[].media`: `distinct`
    // returns `[]`. Zero rows can be emitted, so zero rows can be refused.
    await mongo.collection('posts').insertMany([
      {
        _id: id('e1'),
        replyPermission: REPLY_PERMISSION,
        content: { variants: [{ source: 'author' }] },
      },
    ]);

    expect(
      findingFor(await auditEnums(source, planFor('posts')), 'content.variants.media.type')
    ).toBeUndefined();
  });
});

describe('auditMissingRequired on a field of the DOCUMENT', () => {
  it('still reports an absent top-level field, array-valued or not', async () => {
    // `replyPermission` is array-VALUED and lands on `posts` itself, so one row
    // is emitted per document whatever the field holds — `$exists:false` is the
    // right question and 147,198 production posts answer yes to it. The fix
    // must not widen its way past this.
    await mongo.collection('posts').insertMany([
      { _id: id('f1'), content: { text: 'no replyPermission' } },
      { _id: id('f2'), replyPermission: REPLY_PERMISSION, content: { text: 'has one' } },
    ]);

    const finding = findingFor(await auditEnums(source, planFor('posts')), 'replyPermission');

    expect(finding?.documents).toBe(1);
    expect(finding?.sampleIds).toEqual([String(id('f1'))]);
  });
});
