/**
 * `post_media.post_created_at` — the denormalized copy of `posts.created_at`
 * that `post_media_video_chrono_idx` orders by, and the invariant that has to
 * hold for it to be safe.
 *
 * The sibling of `authorshipChronoSync.test.ts`, and it exists for the same
 * reason that one gives: the Videos lane now ORDERS BY a copied timestamp, so a
 * copy that disagrees with its source does not degrade the lane, it puts a video
 * in the wrong place in it — or below the page boundary, where it reads as the
 * video being missing.
 *
 * The agreement is checked against `posts.created_at` ITSELF rather than against
 * the value the test passed in, so a writer that stores a plausible-but-wrong
 * timestamp fails rather than passing on its own arithmetic.
 *
 * Both write paths are covered, because they are the two that exist:
 * `insertPostRecord` (a new post) and `replacePostContent` (an edit, which
 * DELETEs the media rows and re-inserts them through the same
 * `insertChildRows`). An edit is the interesting one — `posts.updated_at` moves
 * and `created_at` does not, so a writer that reached for the wrong column would
 * be caught only here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postMedia, posts } from '../../db/schema';
import { insertPostRecord, replacePostContent } from '../../db/posts/postRepository';

const OWNER = 'media-chrono-sync-owner';
const created: string[] = [];

/** Backdated, so a writer that stored `now()` instead of the post's own stamp fails. */
const CREATED_AT = new Date('2024-03-04T05:06:07.008Z');

function mediaContent(mediaId: string) {
  return {
    variants: [{ source: 'author' as const, tag: 'en', text: 'a video post' }],
    media: [{ id: mediaId, type: 'video' as const, width: 720, height: 1280, orientation: 'portrait' as const }],
  };
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, created));
    created.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

/** Every media row's copy, beside the post's own `created_at`. */
async function copiesFor(postId: string): Promise<Array<{ copy: Date | null; source: Date }>> {
  const rows = await getDb()
    .select({ copy: postMedia.postCreatedAt, source: posts.createdAt })
    .from(postMedia)
    .innerJoin(posts, eq(posts.id, postMedia.postId))
    .where(eq(postMedia.postId, postId));
  return [...rows];
}

describe('post_media.post_created_at', () => {
  it('agrees with the post it copies, on insert', async () => {
    const record = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.VIDEO,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: CREATED_AT,
      content: mediaContent('media-insert'),
    });
    created.push(record.id);

    const copies = await copiesFor(record.id);
    // Vacuity floor: an empty set agrees with everything.
    expect(copies).toHaveLength(1);
    for (const { copy, source } of copies) {
      expect(copy).not.toBeNull();
      expect(copy?.getTime()).toBe(source.getTime());
      // And it is the POST's stamp, not the row's own write time.
      expect(copy?.getTime()).toBe(CREATED_AT.getTime());
    }
  });

  it('still agrees after an edit replaces the media rows', async () => {
    const record = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.VIDEO,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: CREATED_AT,
      content: mediaContent('media-before-edit'),
    });
    created.push(record.id);

    await replacePostContent(record.id, mediaContent('media-after-edit'), []);

    const copies = await copiesFor(record.id);
    expect(copies).toHaveLength(1);
    // `created_at` does not move on an edit, so the copy must not either.
    expect(copies[0].copy?.getTime()).toBe(CREATED_AT.getTime());
    expect(copies[0].copy?.getTime()).toBe(copies[0].source.getTime());
  });

  it('copies onto EVERY media row a post carries, not just the first', async () => {
    // The row the `DISTINCT ON` in the lane exists for. If only one of a post's
    // media rows carried the stamp, the other would sort last and the post could
    // appear twice in one page — once in place and once at the bottom.
    const record = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.VIDEO,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: CREATED_AT,
      content: {
        variants: [{ source: 'author', tag: 'en', text: 'two videos' }],
        media: [
          { id: 'media-a', type: 'video', width: 720, height: 1280, orientation: 'portrait' },
          { id: 'media-b', type: 'video', width: 720, height: 1280, orientation: 'portrait' },
        ],
      },
    });
    created.push(record.id);

    const copies = await copiesFor(record.id);
    expect(copies).toHaveLength(2);
    for (const { copy, source } of copies) {
      expect(copy?.getTime()).toBe(source.getTime());
    }
  });
});
