import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { bookmarks } from '../db/schema/engagement';

const MAX_FOLDER_LENGTH = 100;

export type BookmarkFolderTarget =
  | { kind: 'postId'; id: string }
  | { kind: 'bookmarkId'; id: string };

export interface BookmarkFolderUpdateResult {
  id: string;
  userId: string;
  postId: string;
  folder: string | null;
}

export class BookmarkFolderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookmarkFolderInputError';
  }
}

/**
 * Reject an empty target id, and nothing else.
 *
 * This replaced an `isObjectIdOrHexString` check, which was not a validation but
 * a second filter: bookmark ids are uuid v7 and `posts.id` is `text` holding
 * pre-cutover ObjectId hex AND post-cutover uuid, so the shape check refused
 * every bookmark and every post created since the cutover — surfacing as "moving
 * this bookmark to a folder does nothing", with a 400 that blamed the client.
 * The ids go into the statement as bound parameters, so no shape check is owed.
 */
function requireTargetId(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new BookmarkFolderInputError(`Invalid ${label}`);
  }
  return trimmed;
}

export function normalizeBookmarkFolder(folder: unknown): string | null {
  if (folder === null || folder === undefined || folder === '') {
    return null;
  }
  if (typeof folder !== 'string') {
    throw new BookmarkFolderInputError('Folder must be a string or null');
  }

  const normalized = folder.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length > MAX_FOLDER_LENGTH) {
    throw new BookmarkFolderInputError(
      `Folder must be at most ${MAX_FOLDER_LENGTH} characters`,
    );
  }
  return normalized;
}

/**
 * Move exactly one viewer-owned bookmark. The explicit target kind prevents a
 * post id from being mistaken for a bookmark row id, while `userId` stays in the
 * update's own WHERE clause so one account can never move another account's
 * bookmark — the ownership check and the write are one statement, not a read
 * followed by a write.
 *
 * Postgres, because that is where bookmarks live: nothing has created a Mongo
 * `Bookmark` since the engagement command service moved, so this update ran
 * against a collection holding only pre-cutover rows. It matched nothing for any
 * bookmark made since, and `findOneAndUpdate` reports that as `null` — the same
 * value it returns for "not yours", so the route could not tell a missing row
 * from a forbidden one and the user just saw the folder fail to change.
 */
export async function updateBookmarkFolderForViewer(input: {
  viewerId: string;
  target: BookmarkFolderTarget;
  folder: unknown;
}): Promise<BookmarkFolderUpdateResult | null> {
  const targetId = requireTargetId(
    input.target.id,
    input.target.kind === 'postId' ? 'post id' : 'bookmark id',
  );
  const folder = normalizeBookmarkFolder(input.folder);

  const [updated] = await getDb()
    .update(bookmarks)
    .set({ folder })
    .where(and(
      eq(bookmarks.userId, input.viewerId),
      input.target.kind === 'postId'
        ? eq(bookmarks.postId, targetId)
        : eq(bookmarks.id, targetId),
    ))
    .returning({
      id: bookmarks.id,
      userId: bookmarks.userId,
      postId: bookmarks.postId,
      folder: bookmarks.folder,
    });

  return updated ?? null;
}
