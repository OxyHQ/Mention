/**
 * Moving a bookmark into a folder, against real rows.
 *
 * This suite used to mock `models/Bookmark` and assert the SHAPE of the Mongo
 * filter it was handed — that `userId` was present, that `_id` was not. That
 * checks the query the code MEANT to send, which is a different question from
 * whether the right row moves: a filter can name `userId` and still be wrong,
 * and a mocked `findOneAndUpdate` returns whatever it was told regardless of
 * what is in the database. Two viewers now hold a bookmark on the SAME post, so
 * "scoped to the viewer" is answered by reading both rows back.
 *
 * That distinction stopped being academic when the service moved to Postgres:
 * nothing had created a Mongo bookmark since engagement moved, so the update ran
 * against a collection holding only pre-cutover rows and silently matched
 * nothing for any bookmark made since — and every assertion in the old suite
 * still passed, because none of them touched a database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { bookmarks } from '../../db/schema/engagement';
import {
  BookmarkFolderInputError,
  normalizeBookmarkFolder,
  updateBookmarkFolderForViewer,
} from '../../services/BookmarkFolderService';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('bookmark-folder-service');
const VIEWER_A = scope.user('viewer-a');
const VIEWER_B = scope.user('viewer-b');

/** The post both viewers bookmark. Created per case so no id is hardcoded. */
async function seedSharedBookmark(): Promise<{ postId: string; bookmarkA: string }> {
  const post = await seedPost(scope);
  const rows = await getDb()
    .insert(bookmarks)
    .values([
      { userId: VIEWER_A, postId: post.id, folder: null },
      { userId: VIEWER_B, postId: post.id, folder: 'viewer-b-folder' },
    ])
    .returning({ id: bookmarks.id, userId: bookmarks.userId });
  const bookmarkA = rows.find((row) => row.userId === VIEWER_A);
  if (!bookmarkA) throw new Error('fixture did not create viewer A bookmark');
  return { postId: post.id, bookmarkA: bookmarkA.id };
}

async function folderOf(userId: string, postId: string): Promise<string | null | undefined> {
  const [row] = await getDb()
    .select({ folder: bookmarks.folder })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.postId, postId)));
  return row?.folder;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('BookmarkFolderService', () => {
  it('moves the viewer relation by postId, and returns the row it moved', async () => {
    const { postId, bookmarkA } = await seedSharedBookmark();

    const result = await updateBookmarkFolderForViewer({
      viewerId: VIEWER_A,
      target: { kind: 'postId', id: postId },
      folder: '  Reading  ',
    });

    expect(result).toMatchObject({ id: bookmarkA, userId: VIEWER_A, postId, folder: 'Reading' });
    expect(await folderOf(VIEWER_A, postId)).toBe('Reading');
  });

  it('cannot move the bookmark another viewer holds on the same post', async () => {
    const { postId } = await seedSharedBookmark();

    const result = await updateBookmarkFolderForViewer({
      viewerId: scope.user('stranger'),
      target: { kind: 'postId', id: postId },
      folder: 'Private',
    });

    expect(result).toBeNull();
    // The positive half: BOTH real rows are untouched. Asserting only the null
    // return would pass against a service that updated every row and returned
    // nothing.
    expect(await folderOf(VIEWER_A, postId)).toBeNull();
    expect(await folderOf(VIEWER_B, postId)).toBe('viewer-b-folder');
  });

  it('keeps the bookmarkId contract scoped to the viewer', async () => {
    const { postId, bookmarkA } = await seedSharedBookmark();

    expect(await updateBookmarkFolderForViewer({
      viewerId: VIEWER_B,
      target: { kind: 'bookmarkId', id: bookmarkA },
      folder: 'stolen',
    })).toBeNull();
    expect(await folderOf(VIEWER_A, postId)).toBeNull();

    await updateBookmarkFolderForViewer({
      viewerId: VIEWER_A,
      target: { kind: 'bookmarkId', id: bookmarkA },
      folder: null,
    });
    expect(await folderOf(VIEWER_A, postId)).toBeNull();
  });

  it('accepts a uuid id, which the old ObjectId shape check refused', async () => {
    // The regression that made this port necessary. `bookmarks.id` is uuid v7
    // and `posts.id` is `text` holding uuid for anything minted after the
    // cutover, so the previous `isObjectIdOrHexString` guard rejected every
    // bookmark a user could actually have created — as a 400 blaming the client.
    const { postId } = await seedSharedBookmark();
    expect(postId).not.toMatch(/^[0-9a-f]{24}$/);

    const result = await updateBookmarkFolderForViewer({
      viewerId: VIEWER_A,
      target: { kind: 'postId', id: postId },
      folder: 'Later',
    });

    expect(result).not.toBeNull();
    expect(await folderOf(VIEWER_A, postId)).toBe('Later');
  });

  it('rejects an empty identifier without touching the database', async () => {
    await expect(updateBookmarkFolderForViewer({
      viewerId: VIEWER_A,
      target: { kind: 'postId', id: '   ' },
      folder: 'Reading',
    })).rejects.toBeInstanceOf(BookmarkFolderInputError);
  });

  it('normalizes empty folders and rejects unbounded or non-string values', () => {
    expect(normalizeBookmarkFolder('   ')).toBeNull();
    expect(normalizeBookmarkFolder(undefined)).toBeNull();
    expect(() => normalizeBookmarkFolder({ name: 'private' }))
      .toThrow(BookmarkFolderInputError);
    expect(() => normalizeBookmarkFolder('x'.repeat(101)))
      .toThrow(BookmarkFolderInputError);
  });
});
