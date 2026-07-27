import {
  buildBookmarkFolderMoveRequest,
  buildSavedPostsRequestConfig,
} from '@/services/savedPostsRequest';

describe('saved-post request config', () => {
  it('preserves page, filters and the query cancellation signal', () => {
    const controller = new AbortController();

    expect(buildSavedPostsRequestConfig({
      page: 2,
      limit: 30,
      search: 'oxy',
      folder: 'work',
      signal: controller.signal,
    })).toEqual({
      params: {
        page: 2,
        limit: 30,
        search: 'oxy',
        folder: 'work',
      },
      signal: controller.signal,
    });
  });

  it('uses bounded API defaults without emitting empty optional filters', () => {
    expect(buildSavedPostsRequestConfig({})).toEqual({
      params: { page: 1, limit: 20 },
      signal: undefined,
    });
  });

  it('moves a bookmark through the explicit viewer-post relation route', () => {
    expect(buildBookmarkFolderMoveRequest('post/unsafe', ' Reading '))
      .toEqual({
        url: '/posts/bookmarks/by-post/post%2Funsafe/folder',
        data: { folder: ' Reading ' },
      });
  });
});
