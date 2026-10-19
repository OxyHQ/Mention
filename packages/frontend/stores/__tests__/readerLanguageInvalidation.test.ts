import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  isFeedCacheStaleForReaderLanguages,
  noteReaderLanguages,
  resetReaderLanguageInvalidation,
  subscribeToReaderLanguageChanges,
} from '../readerLanguageInvalidation';

afterAll(() => {
  queryClient.clear();
});

it('refetches cached posts only when the same reader reorders their languages', () => {
  resetReaderLanguageInvalidation();
  queryClient.clear();
  const post = viewerQueryKeys.post('viewer-a', 'post-1');
  const unrelated = viewerQueryKeys.bookmarkFolders('viewer-a');
  queryClient.setQueryData(post, {});
  queryClient.setQueryData(unrelated, []);
  const reload = jest.fn();
  const unsubscribe = subscribeToReaderLanguageChanges(reload);
  const readBefore = Date.now();

  // Establishing a reader's languages (cold boot, sign-in, a switch) is not a change.
  noteReaderLanguages('viewer-a', ['es-ES', 'en-US', 'ca-ES']);
  noteReaderLanguages('viewer-a', ['es-ES', 'en-US', 'ca-ES']);
  noteReaderLanguages('viewer-b', ['ca-ES', 'es-ES', 'en-US']);
  expect(reload).not.toHaveBeenCalled();
  expect(queryClient.getQueryState(post)?.isInvalidated).toBe(false);

  noteReaderLanguages('viewer-b', ['es-ES', 'ca-ES', 'en-US']);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(queryClient.getQueryState(post)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
  expect(isFeedCacheStaleForReaderLanguages(readBefore)).toBe(true);

  unsubscribe();
});
