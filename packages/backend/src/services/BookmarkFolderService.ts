import mongoose from 'mongoose';
import Bookmark from '../models/Bookmark';

const MAX_FOLDER_LENGTH = 100;

export type BookmarkFolderTarget =
  | { kind: 'postId'; id: string }
  | { kind: 'bookmarkId'; id: string };

export interface BookmarkFolderUpdateResult {
  _id: unknown;
  userId: string;
  postId: mongoose.Types.ObjectId;
  folder: string | null;
}

export class BookmarkFolderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookmarkFolderInputError';
  }
}

function normalizeObjectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.isObjectIdOrHexString(value)) {
    throw new BookmarkFolderInputError(`Invalid ${label}`);
  }
  return new mongoose.Types.ObjectId(value);
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
 * post id from being mistaken for a Bookmark document id, while `userId` stays
 * in the atomic update filter so one account can never move another account's
 * bookmark.
 */
export async function updateBookmarkFolderForViewer(input: {
  viewerId: string;
  target: BookmarkFolderTarget;
  folder: unknown;
}): Promise<BookmarkFolderUpdateResult | null> {
  const targetId = normalizeObjectId(
    input.target.id,
    input.target.kind === 'postId' ? 'post id' : 'bookmark id',
  );
  const folder = normalizeBookmarkFolder(input.folder);
  const targetFilter = input.target.kind === 'postId'
    ? { postId: targetId }
    : { _id: targetId };

  const bookmark = await Bookmark.findOneAndUpdate(
    {
      userId: input.viewerId,
      ...targetFilter,
    },
    { $set: { folder } },
    {
      new: true,
      runValidators: true,
    },
  );
  return bookmark as unknown as BookmarkFolderUpdateResult | null;
}
