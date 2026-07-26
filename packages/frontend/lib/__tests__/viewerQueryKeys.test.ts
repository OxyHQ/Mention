import { QueryClient } from '@tanstack/react-query';
import {
  clearViewerQueryCache,
  viewerQueryKeys,
  viewerStorageKey,
} from '@/lib/viewerQueryKeys';

describe('viewer-scoped private cache', () => {
  it('keeps A and B on distinct query and storage keys', () => {
    expect(viewerQueryKeys.search('viewer-a', 'saved', 'oxy', true)).not.toEqual(
      viewerQueryKeys.search('viewer-b', 'saved', 'oxy', true),
    );
    expect(viewerQueryKeys.livePresence('viewer-a')).not.toEqual(
      viewerQueryKeys.livePresence('viewer-b'),
    );
    expect(viewerQueryKeys.savedPosts('viewer-a', '', null)).not.toEqual(
      viewerQueryKeys.savedPosts('viewer-b', '', null),
    );
    expect(viewerQueryKeys.bookmarkFolders('viewer-a')).not.toEqual(
      viewerQueryKeys.bookmarkFolders('viewer-b'),
    );
    expect(viewerStorageKey('history', 'viewer-a')).toBe('history:viewer-a');
    expect(viewerStorageKey('history', 'viewer-b')).toBe('history:viewer-b');
  });

  it('removes only A when the active account switches A to B', async () => {
    const queryClient = new QueryClient();
    const aSearch = viewerQueryKeys.search('viewer-a', 'saved', 'oxy', true);
    const aPresence = viewerQueryKeys.livePresence('viewer-a');
    const aSaved = viewerQueryKeys.savedPosts('viewer-a', 'query', 'work');
    const aFolders = viewerQueryKeys.bookmarkFolders('viewer-a');
    const bSearch = viewerQueryKeys.search('viewer-b', 'saved', 'oxy', true);

    queryClient.setQueryData(aSearch, { owner: 'viewer-a' });
    queryClient.setQueryData(aPresence, 'speaking');
    queryClient.setQueryData(aSaved, [{ owner: 'viewer-a' }]);
    queryClient.setQueryData(aFolders, ['work']);
    queryClient.setQueryData(bSearch, { owner: 'viewer-b' });

    await clearViewerQueryCache(queryClient, 'viewer-a');

    expect(queryClient.getQueryData(aSearch)).toBeUndefined();
    expect(queryClient.getQueryData(aPresence)).toBeUndefined();
    expect(queryClient.getQueryData(aSaved)).toBeUndefined();
    expect(queryClient.getQueryData(aFolders)).toBeUndefined();
    expect(queryClient.getQueryData(bSearch)).toEqual({ owner: 'viewer-b' });

    queryClient.clear();
  });
});
