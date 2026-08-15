/**
 * `posts.has_links` is derived from the body, on every write path, against a
 * real database.
 *
 * ## What this pins, and why it is not a unit test of the detector
 *
 * `postTextHasHttpLink` already has its own unit test
 * (`utils/postSearchMetadata.test.ts`). That test passed the entire time the bug
 * was live, because the detector was never wrong — it was simply not CALLED by
 * any writer except the ActivityPub outbox backfill. `hasLinks` was an optional
 * field on `PostRecordInput`, `toPostInsert` defaulted it to `false`, and every
 * other writer (`PostCreationService`, the reply and boost paths in
 * `feed.controller`, `PostMaterializer`) omitted it. So a native post full of
 * URLs stored `has_links = false`, and `filter:links` — which is
 * `eq(posts.hasLinks, true)` in `routes/search.ts` — matched no native post at
 * all. The query stayed valid and returned rows; it just silently omitted
 * everything local.
 *
 * A test of the detector cannot see that, and neither can `tsc`: an optional
 * field is omitted correctly by construction. Only a test that reads the COLUMN
 * BACK after a write can. Hence: rows, both halves, both directions.
 *
 * ## Both halves
 *
 * CREATE is `toPostInsert`; EDIT is `replacePostContent`, the one function every
 * content-changing path in the tree goes through. The edit half needs its own
 * cases in BOTH directions — a post edited to add a link and a post edited to
 * remove one — because a derivation that only ever sets the flag TRUE is
 * indistinguishable from a correct one until somebody deletes a URL.
 *
 * ## Mutation results (each applied, diffed, run, restored)
 *
 *  - `toPostInsert`: `postTextHasHttpLink(content.variants)` -> `false`
 *      => 3 fail. Both create cases that expect TRUE, plus the link-removing
 *         edit case, whose precondition is a created row that already has one.
 *         The two create cases expecting FALSE stay green, correctly: `false` is
 *         still the right answer for them, which is why a fixture set of only
 *         link-bearing bodies would have measured nothing.
 *  - `replacePostContent`: the `hasLinks:` line deleted
 *      => 2 fail, the two edit cases that change the answer. The pass-through
 *         case stays green, also correctly — nothing should change there, and a
 *         red on it would mean this file was asserting the write rather than the
 *         value.
 *  - `replacePostContent`: `postTextHasHttpLink(content.variants)` -> `true`
 *      => 1 fails, the link-removing edit case. That is the whole point of
 *         having it: every other case in this file is green under a derivation
 *         that can only ever set the flag.
 *
 * A fourth, on the READER rather than the writer, lives with the test it
 * belongs to: replacing `eq(posts.hasLinks, true)` in `routes/search.ts` with an
 * `EXISTS` scan over the bodies fails
 * `routes/searchPosts.test.ts > selects has:links from the stored flag rather
 * than scanning the body` — on the assertion where the column and the bodies
 * deliberately disagree, and only on that one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { StoredPostContent } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  insertPostRecord,
  replacePostContent,
} from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';

let db: Database;
const created: string[] = [];

const AUTHOR = 'oxy-haslinks-author';

function baseInput(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'hello', tag: 'en' }] },
    ...overrides,
  };
}

function body(text: string): StoredPostContent {
  return { variants: [{ source: 'author', text, tag: 'en' }] };
}

async function create(content: StoredPostContent): Promise<string> {
  const record = await insertPostRecord(baseInput({ content }));
  created.push(record.id);
  return record.id;
}

/**
 * The COLUMN, read straight out of the table.
 *
 * Deliberately not `PostRecord.hasLinks`: the assembled record and the row could
 * both be wrong together if the projection ever grew a default of its own, and
 * the column is what `routes/search.ts` filters on.
 */
async function storedHasLinks(postId: string): Promise<boolean> {
  const [row] = await db
    .select({ hasLinks: posts.hasLinks })
    .from(posts)
    .where(eq(posts.id, postId));
  if (!row) throw new Error(`post ${postId} was not readable`);
  return row.hasLinks;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (created.length > 0) {
    const id = created.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
  await db.delete(posts).where(eq(posts.oxyUserId, AUTHOR));
});

afterAll(async () => {
  await closePostgres();
});

describe('has_links on create', () => {
  it('is true for a body containing a link, and false for one that does not', async () => {
    const linked = await create(body('read this https://example.test/article'));
    const plain = await create(body('no link here, just words'));

    expect(await storedHasLinks(linked)).toBe(true);
    expect(await storedHasLinks(plain)).toBe(false);
  });

  it('is true when only a SECONDARY rendition carries the link', async () => {
    // A translated or per-language rendition is a body a reader can be served,
    // so a link in it is a link in the post. Reading only `variants[0]` would
    // answer false here, which is the same silent omission one variant deep.
    const id = await create({
      variants: [
        { source: 'author', text: 'sin enlace', tag: 'es' },
        { source: 'author', text: 'with a link https://example.test', tag: 'en' },
      ],
    });

    expect(await storedHasLinks(id)).toBe(true);
  });

  it('does not treat a bare domain as a link', async () => {
    // The column backs `filter:links`, and a plain-text domain is not something
    // a reader can follow. This is the detector's own rule; asserted here so the
    // write path cannot quietly widen it.
    const id = await create(body('example.com is plain text'));

    expect(await storedHasLinks(id)).toBe(false);
  });

  it('is false for a post with no renditions at all', async () => {
    // A bare boost. `postTextHasHttpLink(undefined)` is the path taken.
    const id = await create({ variants: [] });

    expect(await storedHasLinks(id)).toBe(false);
  });
});

describe('has_links on edit', () => {
  it('turns true when an edit adds a link', async () => {
    const id = await create(body('nothing to click'));
    expect(await storedHasLinks(id)).toBe(false);

    await replacePostContent(id, body('now with https://example.test'), []);

    expect(await storedHasLinks(id)).toBe(true);
  });

  it('turns false when an edit removes the only link', async () => {
    // The direction a set-only derivation gets wrong. A post edited to drop its
    // URL keeps matching `filter:links` forever otherwise.
    const id = await create(body('see https://example.test'));
    expect(await storedHasLinks(id)).toBe(true);

    await replacePostContent(id, body('link removed'), []);

    expect(await storedHasLinks(id)).toBe(false);
  });

  it('leaves the flag alone when an edit carries the same body through', async () => {
    // The media-metadata enrich job and the media backfill both call
    // `replacePostContent` with the EXISTING variants and a new media set. A
    // derivation is safe at that seam precisely because it recomputes the same
    // answer from the same text — this is the assertion that says so.
    const content = body('read this https://example.test/article');
    const id = await create(content);

    await replacePostContent(
      id,
      { ...content, media: [{ id: 'file-1', type: 'image' }] },
      [],
    );

    expect(await storedHasLinks(id)).toBe(true);
  });
});
