import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateBookmarkFolderForViewer: vi.fn(),
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

vi.mock('../../services/BookmarkFolderService', () => {
  class BookmarkFolderInputError extends Error {}
  return {
    BookmarkFolderInputError,
    updateBookmarkFolderForViewer: mocks.updateBookmarkFolderForViewer,
  };
});

import { moveBookmarkToFolderByPostId } from '../../controllers/posts/bookmarks';
import postsRouter from '../../routes/posts';

const POST_ID = '507f1f77bcf86cd799439011';

function responseDouble() {
  const response = {
    json: vi.fn(),
    status: vi.fn(),
  };
  response.json.mockReturnValue(response);
  response.status.mockReturnValue(response);
  return response;
}

describe('bookmark folder route by post id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the explicit PATCH route before the compatibility route', () => {
    const paths = (
      postsRouter as unknown as {
        stack: Array<{
          route?: { path?: string; methods?: Record<string, boolean> };
        }>;
      }
    ).stack
      .filter((layer) => layer.route?.methods?.patch)
      .map((layer) => layer.route?.path);

    expect(paths).toContain('/bookmarks/by-post/:postId/folder');
    expect(paths.indexOf('/bookmarks/by-post/:postId/folder'))
      .toBeLessThan(paths.indexOf('/bookmarks/:id/folder'));
  });

  it('passes only the authenticated viewer and post relation to the service', async () => {
    const bookmark = { _id: 'bookmark-a', userId: 'viewer-a', postId: POST_ID };
    mocks.updateBookmarkFolderForViewer.mockResolvedValue(bookmark);
    const response = responseDouble();

    await moveBookmarkToFolderByPostId({
      user: { id: 'viewer-a' },
      params: { postId: POST_ID },
      body: { folder: 'Reading' },
    } as never, response as never);

    expect(mocks.updateBookmarkFolderForViewer).toHaveBeenCalledWith({
      viewerId: 'viewer-a',
      target: { kind: 'postId', id: POST_ID },
      folder: 'Reading',
    });
    expect(response.json).toHaveBeenCalledWith({ bookmark });
    expect(response.status).not.toHaveBeenCalled();
  });

  it('does not query without an authenticated viewer', async () => {
    const response = responseDouble();

    await moveBookmarkToFolderByPostId({
      params: { postId: POST_ID },
      body: { folder: 'Reading' },
    } as never, response as never);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(mocks.updateBookmarkFolderForViewer).not.toHaveBeenCalled();
  });

  it('returns 404 when the viewer has no bookmark relation for the post', async () => {
    mocks.updateBookmarkFolderForViewer.mockResolvedValue(null);
    const response = responseDouble();

    await moveBookmarkToFolderByPostId({
      user: { id: 'viewer-b' },
      params: { postId: POST_ID },
      body: { folder: null },
    } as never, response as never);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ message: 'Bookmark not found' });
  });
});
