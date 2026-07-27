import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../models/Bookmark', () => ({
  default: {
    findOneAndUpdate: vi.fn(),
  },
}));

import Bookmark from '../../models/Bookmark';
import {
  BookmarkFolderInputError,
  normalizeBookmarkFolder,
  updateBookmarkFolderForViewer,
} from '../../services/BookmarkFolderService';

const POST_ID = '507f1f77bcf86cd799439011';
const BOOKMARK_ID = '507f191e810c19729de860ea';

describe('BookmarkFolderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates the viewer relation by postId without exposing a Bookmark id', async () => {
    const bookmark = {
      _id: BOOKMARK_ID,
      userId: 'viewer-a',
      postId: POST_ID,
      folder: 'Reading',
    };
    vi.mocked(Bookmark.findOneAndUpdate).mockResolvedValue(bookmark as never);

    await expect(updateBookmarkFolderForViewer({
      viewerId: 'viewer-a',
      target: { kind: 'postId', id: POST_ID },
      folder: '  Reading  ',
    })).resolves.toBe(bookmark);

    const [filter, update, options] =
      vi.mocked(Bookmark.findOneAndUpdate).mock.calls[0] ?? [];
    expect(filter).toMatchObject({ userId: 'viewer-a' });
    expect(String((filter as { postId: unknown }).postId)).toBe(POST_ID);
    expect(filter).not.toHaveProperty('_id');
    expect(update).toEqual({ $set: { folder: 'Reading' } });
    expect(options).toEqual({ new: true, runValidators: true });
  });

  it('cannot update the same post relation owned by another viewer', async () => {
    vi.mocked(Bookmark.findOneAndUpdate).mockResolvedValue(null);

    await expect(updateBookmarkFolderForViewer({
      viewerId: 'viewer-b',
      target: { kind: 'postId', id: POST_ID },
      folder: 'Private',
    })).resolves.toBeNull();

    expect(Bookmark.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'viewer-b' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps the legacy bookmarkId contract scoped to the viewer', async () => {
    vi.mocked(Bookmark.findOneAndUpdate).mockResolvedValue(null);

    await updateBookmarkFolderForViewer({
      viewerId: 'viewer-a',
      target: { kind: 'bookmarkId', id: BOOKMARK_ID },
      folder: null,
    });

    const filter = vi.mocked(Bookmark.findOneAndUpdate).mock.calls[0]?.[0];
    expect(filter).toMatchObject({ userId: 'viewer-a' });
    expect(String((filter as { _id: unknown })._id)).toBe(BOOKMARK_ID);
    expect(filter).not.toHaveProperty('postId');
  });

  it('rejects malformed identifiers before querying Mongo', async () => {
    await expect(updateBookmarkFolderForViewer({
      viewerId: 'viewer-a',
      target: { kind: 'postId', id: 'not-an-object-id' },
      folder: 'Reading',
    })).rejects.toBeInstanceOf(BookmarkFolderInputError);

    expect(Bookmark.findOneAndUpdate).not.toHaveBeenCalled();
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
