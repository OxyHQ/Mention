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
import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { bookmarkFolders, bookmarks } from '../../db/schema/engagement';
import {
  BookmarkFolderInputError,
  MAX_BOOKMARK_FOLDERS_PER_VIEWER,
  createBookmarkFolderForViewer,
  listBookmarkFoldersForViewer,
  normalizeBookmarkFolder,
  updateBookmarkFolderForViewer,
} from '../../services/BookmarkFolderService';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('bookmark-folder-service');
const VIEWER_A = scope.user('viewer-a');
const VIEWER_B = scope.user('viewer-b');
const STRANGER = scope.user('stranger');

/** The post both viewers bookmark. Created per case so no id is hardcoded. */
async function seedSharedBookmark(): Promise<{ postId: string; bookmarkA: string }> {
  const post = await seedPost(scope);
  // A filed bookmark names a folder that exists: the foreign key sees to it.
  await getDb().insert(bookmarkFolders).values({ userId: VIEWER_B, name: 'viewer-b-folder' });
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
  // Posts first: their bookmarks cascade, and only then may the folders go.
  await clearPostScope(scope);
  await getDb()
    .delete(bookmarkFolders)
    .where(inArray(bookmarkFolders.userId, [VIEWER_A, VIEWER_B, STRANGER]));
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
      viewerId: STRANGER,
      target: { kind: 'postId', id: postId },
      folder: 'Private',
    });

    expect(result).toBeNull();
    // Nor did the attempt leave the stranger a folder as a side effect.
    expect(await listBookmarkFoldersForViewer(STRANGER)).toEqual([]);
    // The positive half: BOTH real rows are untouched. Asserting only the null
    // return would pass against a service that updated every row and returned
    // nothing.
    expect(await folderOf(VIEWER_A, postId)).toBeNull();
    expect(await folderOf(VIEWER_B, postId)).toBe('viewer-b-folder');
  });

  it('keeps the bookmarkId contract scoped to the viewer', async () => {
    const { postId, bookmarkA } = await seedSharedBookmark();

    expect(
      await updateBookmarkFolderForViewer({
        viewerId: VIEWER_B,
        target: { kind: 'bookmarkId', id: bookmarkA },
        folder: 'stolen',
      }),
    ).toBeNull();
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
    await expect(
      updateBookmarkFolderForViewer({
        viewerId: VIEWER_A,
        target: { kind: 'postId', id: '   ' },
        folder: 'Reading',
      }),
    ).rejects.toBeInstanceOf(BookmarkFolderInputError);
  });

  it('normalizes empty folders and rejects unbounded or non-string values', () => {
    expect(normalizeBookmarkFolder('   ')).toBeNull();
    expect(normalizeBookmarkFolder(undefined)).toBeNull();
    expect(() => normalizeBookmarkFolder({ name: 'private' })).toThrow(BookmarkFolderInputError);
    expect(() => normalizeBookmarkFolder('x'.repeat(101))).toThrow(BookmarkFolderInputError);
  });

  it('files a bookmark into a new folder by name, creating the folder with it', async () => {
    const { postId } = await seedSharedBookmark();

    await updateBookmarkFolderForViewer({
      viewerId: VIEWER_A,
      target: { kind: 'postId', id: postId },
      folder: 'Recipes',
    });

    expect(await listBookmarkFoldersForViewer(VIEWER_A)).toEqual(['Recipes']);
  });

  it('refuses a bookmark naming a folder that does not exist, at the database', async () => {
    const post = await seedPost(scope);
    await expect(
      getDb().insert(bookmarks).values({ userId: VIEWER_A, postId: post.id, folder: 'nowhere' }),
    ).rejects.toThrow();
  });
});

/**
 * OxyHQ/Mention#1124: a folder created on the Saved screen vanished on reload,
 * because a folder only existed as a value on some bookmark.
 */
describe('creating an empty folder', () => {
  it('persists it, empty, as a folder the viewer lists', async () => {
    expect(await createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: '  QA-empty  ' })).toBe(
      'QA-empty',
    );

    expect(await listBookmarkFoldersForViewer(VIEWER_A)).toEqual(['QA-empty']);
    const filed = await getDb().select().from(bookmarks).where(eq(bookmarks.userId, VIEWER_A));
    expect(filed).toEqual([]);
  });

  it('is a destination before anything is in it', async () => {
    await createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: 'Later' });
    const { postId } = await seedSharedBookmark();

    await updateBookmarkFolderForViewer({
      viewerId: VIEWER_A,
      target: { kind: 'postId', id: postId },
      folder: 'Later',
    });

    expect(await folderOf(VIEWER_A, postId)).toBe('Later');
    expect(await listBookmarkFoldersForViewer(VIEWER_A)).toEqual(['Later']);
  });

  it('is idempotent: creating it twice leaves one folder', async () => {
    await createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: 'Reading' });
    await createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: 'Reading' });

    expect(await listBookmarkFoldersForViewer(VIEWER_A)).toEqual(['Reading']);
  });

  it('belongs to its account alone', async () => {
    await createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: 'Mine' });

    expect(await listBookmarkFoldersForViewer(VIEWER_B)).toEqual([]);
  });

  it('refuses a blank or oversized name', async () => {
    await expect(
      createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: '   ' }),
    ).rejects.toBeInstanceOf(BookmarkFolderInputError);
    await expect(
      createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: 'x'.repeat(101) }),
    ).rejects.toBeInstanceOf(BookmarkFolderInputError);
    expect(await listBookmarkFoldersForViewer(VIEWER_A)).toEqual([]);
  });

  it('stops at the per-account folder limit', async () => {
    await getDb()
      .insert(bookmarkFolders)
      .values(
        Array.from({ length: MAX_BOOKMARK_FOLDERS_PER_VIEWER }, (_, i) => ({
          userId: VIEWER_A,
          name: `f${i}`,
        })),
      );

    await expect(
      createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: 'one too many' }),
    ).rejects.toBeInstanceOf(BookmarkFolderInputError);
    // An existing folder is not "a new one", so naming it still works.
    await expect(createBookmarkFolderForViewer({ viewerId: VIEWER_A, name: 'f0' })).resolves.toBe(
      'f0',
    );
  });
});
