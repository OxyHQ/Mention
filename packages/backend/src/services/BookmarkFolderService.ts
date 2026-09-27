import { and, asc, count, eq } from 'drizzle-orm';
import { getDb, type Transaction } from '../db/postgres';
import {
  BOOKMARK_FOLDER_NAME_MAX_LENGTH,
  bookmarkFolders,
  bookmarks,
} from '../db/schema/engagement';

/**
 * How many folders one account may keep. Generous for filing, and a bound on
 * what a single account can make the folder list (and this table) hold.
 */
export const MAX_BOOKMARK_FOLDERS_PER_VIEWER = 200;

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
  if (normalized.length > BOOKMARK_FOLDER_NAME_MAX_LENGTH) {
    throw new BookmarkFolderInputError(
      `Folder must be at most ${BOOKMARK_FOLDER_NAME_MAX_LENGTH} characters`,
    );
  }
  return normalized;
}

/** The viewer's folders, oldest first — the order they were made in. */
export async function listBookmarkFoldersForViewer(viewerId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ name: bookmarkFolders.name })
    .from(bookmarkFolders)
    .where(eq(bookmarkFolders.userId, viewerId))
    .orderBy(asc(bookmarkFolders.createdAt), asc(bookmarkFolders.name));
  return rows.map((row) => row.name);
}

/**
 * Make sure the viewer has a folder with this name, inside `tx`. Idempotent: an
 * existing folder is left as it is — one statement, the common case. Only a
 * folder this call actually created is counted against
 * {@link MAX_BOOKMARK_FOLDERS_PER_VIEWER}, and one past the limit throws, which
 * rolls the insert back with the transaction.
 */
async function ensureFolder(tx: Transaction, viewerId: string, name: string): Promise<void> {
  // `do nothing` rather than a failure: two requests creating the same folder
  // at once both mean "this folder should exist", and it does.
  const created = await tx
    .insert(bookmarkFolders)
    .values({ userId: viewerId, name })
    .onConflictDoNothing({ target: [bookmarkFolders.userId, bookmarkFolders.name] })
    .returning({ id: bookmarkFolders.id });
  if (created.length === 0) return;

  const [{ total }] = await tx
    .select({ total: count() })
    .from(bookmarkFolders)
    .where(eq(bookmarkFolders.userId, viewerId));
  if (total > MAX_BOOKMARK_FOLDERS_PER_VIEWER) {
    throw new BookmarkFolderInputError(
      `You can keep at most ${MAX_BOOKMARK_FOLDERS_PER_VIEWER} folders`,
    );
  }
}

/**
 * Create a folder, empty. It exists — in the folder list and as a destination —
 * before anything is filed in it. Creating one that already exists is not an
 * error: the result is the same folder.
 */
export async function createBookmarkFolderForViewer(input: {
  viewerId: string;
  name: unknown;
}): Promise<string> {
  const name = normalizeBookmarkFolder(input.name);
  if (!name) {
    throw new BookmarkFolderInputError('Folder name is required');
  }
  await getDb().transaction((tx) => ensureFolder(tx, input.viewerId, name));
  return name;
}

/**
 * Move exactly one viewer-owned bookmark. The explicit target kind prevents a
 * post id from being mistaken for a bookmark row id, while `userId` stays in the
 * WHERE clause of both the lookup and the update, so one account can never move
 * another account's bookmark.
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

  const ownBookmark = and(
    eq(bookmarks.userId, input.viewerId),
    input.target.kind === 'postId'
      ? eq(bookmarks.postId, targetId)
      : eq(bookmarks.id, targetId),
  );

  // Filing into a folder by name creates it when it is new, in the same
  // transaction, so the bookmark's foreign key always finds its folder. The
  // bookmark is looked up first: moving a bookmark that is not the viewer's (or
  // does not exist) must not leave a folder behind as a side effect.
  const updated = await getDb().transaction(async (tx) => {
    const [target] = await tx.select({ id: bookmarks.id }).from(bookmarks).where(ownBookmark);
    if (!target) return undefined;
    if (folder) await ensureFolder(tx, input.viewerId, folder);
    const [row] = await tx
      .update(bookmarks)
      .set({ folder })
      .where(and(eq(bookmarks.id, target.id), eq(bookmarks.userId, input.viewerId)))
      .returning({
        id: bookmarks.id,
        userId: bookmarks.userId,
        postId: bookmarks.postId,
        folder: bookmarks.folder,
      });
    return row;
  });

  return updated ?? null;
}
