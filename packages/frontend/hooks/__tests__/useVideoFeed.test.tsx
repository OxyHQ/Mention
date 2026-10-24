import TestRenderer, { act } from 'react-test-renderer';
import { useLayoutEffect } from 'react';
import { logger } from '@oxy.so/core/logger';
import { useVideoFeed, type VideoTarget } from '../useVideoFeed';

type Item = { id: string; mediaId: string; mediaIndex: number };
const item = (id: string, mediaIndex = 0): Item => ({
  id,
  mediaId: `${id}-${mediaIndex}`,
  mediaIndex,
});
const A = item('a');
const B = item('b', 1);
const C = item('c');
const deferred = <T,>() => Promise.withResolvers<T>();

type Options = Parameters<typeof useVideoFeed<Item>>[0];
let result: ReturnType<typeof useVideoFeed<Item>>;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let options: Options;
function Harness({ value }: { value: Options }) {
  const current = useVideoFeed(value);
  useLayoutEffect(() => {
    result = current;
  });
  return null;
}
async function render(change: Partial<Options> = {}) {
  options = { ...options, ...change };
  await act(async () => {
    if (renderer) renderer.update(<Harness value={options} />);
    else renderer = TestRenderer.create(<Harness value={options} />);
  });
}
beforeEach(() => {
  renderer = undefined;
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  options = {
    target: null,
    focused: true,
    navigationEntry: {},
    signedOut: false,
    viewerId: 'viewer',
    readTarget: jest.fn(async (target: VideoTarget) => item(target.postId, target.mediaIndex)),
    readPage: jest.fn(async () => ({ items: [B, C], hasMore: false })),
    cachePosts: jest.fn(),
    resetScroll: jest.fn(),
  };
});
afterEach(async () => {
  const mounted = renderer;
  if (mounted) await act(async () => mounted.unmount());
  jest.restoreAllMocks();
});

describe('reel navigation owns post and media selection', () => {
  it('opens an explicit target from retained Following before delayed ranked data', async () => {
    await render();
    await act(async () => result.selectFeed('following'));
    await render({ focused: false });
    const ranked = deferred<{ items: Item[]; hasMore: boolean }>();
    options.readPage = jest.fn(() => ranked.promise);
    await render({ focused: true, target: { postId: 'a', mediaIndex: 0 } });
    expect(result.activeFeed).toBe('videos');
    expect(result.posts).toEqual([A]);
    expect(result.currentVisibleIndex).toBe(0);
    await act(async () => ranked.resolve({ items: [C, item('a', 1), B], hasMore: false }));
    expect(result.posts).toEqual([A, C, B]);
    expect(result.posts[result.currentVisibleIndex]).toEqual(A);
  });

  it('treats the same target on a later entry as new intent without disabling manual Following', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await act(async () => result.selectFeed('following'));
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    expect(result.activeFeed).toBe('following');
    await render({ focused: false });
    await render({ focused: true, navigationEntry: {} });
    expect(result.activeFeed).toBe('videos');
    expect(result.posts[0]).toEqual(A);
    expect(options.readTarget).toHaveBeenCalledTimes(2);
  });

  it('resumes the selected video on ordinary Back without reinterpreting retained route params', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await act(async () => result.selectIndex(1));
    await render({ focused: false });
    await render({ focused: true });
    expect(result.posts[result.currentVisibleIndex]).toEqual(B);
    expect(options.readTarget).toHaveBeenCalledTimes(1);
  });

  it('ignores native viewability from an old session even when that post appears in the new ranked page', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    const oldSelectPost = result.selectPost;
    await render({
      target: { postId: 'b', mediaIndex: 1 },
      readPage: jest.fn(async () => ({ items: [A] })),
    });
    await act(async () => oldSelectPost(A));
    expect(result.posts[result.currentVisibleIndex]).toEqual(B);
  });

  it('deduplicates repeated post IDs within a single response', async () => {
    await render({ readPage: jest.fn(async () => ({ items: [A, item('a', 1), B, B] })) });
    expect(result.posts).toEqual([A, B]);
    expect(options.cachePosts).toHaveBeenCalledWith([A, B]);
  });

  it('retains an explicit target when route params disappear, then recognizes repeated params', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await render({ target: null });
    expect(result.posts[0]).toEqual(A);
    await act(async () => result.selectFeed('following'));
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    expect(result.activeFeed).toBe('videos');
    expect(result.posts[0]).toEqual(A);
  });

  it('changes media within the same post on explicit navigation', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await render({ target: { postId: 'a', mediaIndex: 1 } });
    expect(result.posts[0]).toEqual(item('a', 1));
  });

  it('does not reload or re-pin a target when resolver callbacks are recreated', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await act(async () => result.selectIndex(1));
    const posts = result.posts;
    const readTarget = jest.fn(async () => A);
    const readPage = jest.fn(async () => ({ items: [C] }));
    await render({ readTarget, readPage, cachePosts: jest.fn(), resetScroll: jest.fn() });
    expect(result.posts).toBe(posts);
    expect(result.posts[result.currentVisibleIndex]).toEqual(B);
    expect(readTarget).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });

  it('revalidates the currently selected media when viewer identity changes', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await act(async () => result.selectIndex(1));
    await render({ viewerId: 'signed-in-viewer' });
    expect(options.readTarget).toHaveBeenLastCalledWith({
      postId: 'b',
      mediaIndex: 1,
      mediaId: B.mediaId,
    });
    expect(result.posts[result.currentVisibleIndex]).toEqual(B);
  });

  it('ignores an old target result after a newer route has loaded', async () => {
    const pending = deferred<Item | null>();
    options.readTarget = jest.fn((target) =>
      target.postId === 'a' ? pending.promise : Promise.resolve(B),
    );
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await render({ target: { postId: 'b', mediaIndex: 1 } });
    await act(async () => pending.resolve(A));
    expect(result.posts[0]).toEqual(B);
    expect(result.posts).not.toContainEqual(A);
  });

  it('ignores an old ranked page and old viewport callback after a new entry', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    const oldSelect = result.selectIndex;
    const pending = deferred<{ items: Item[]; hasMore: boolean; nextCursor?: string }>();
    options.readPage = jest.fn(() => pending.promise);
    await render({ target: { postId: 'b', mediaIndex: 1 } });
    await render({
      target: { postId: 'c', mediaIndex: 0 },
      readPage: jest.fn(async () => ({ items: [A] })),
    });
    await act(async () => pending.resolve({ items: [B], hasMore: false }));
    await act(async () => oldSelect(0));
    expect(result.posts).toEqual([C, A]);
    expect(result.posts[result.currentVisibleIndex]).toEqual(C);
  });

  it.each(['missing', 'rejected', 'wrong-post'] as const)(
    'keeps a %s explicit target as an error, never another ranked video',
    async (failure) => {
      options.readTarget = jest.fn(async () => {
        if (failure === 'rejected') throw new Error('unavailable');
        return failure === 'wrong-post' ? B : null;
      });
      await render({ target: { postId: 'a', mediaIndex: 0 } });
      expect(result.posts).toEqual([]);
      expect(result.hasLoadError).toBe(true);
      expect(result.isLoading).toBe(false);
      expect(options.readPage).not.toHaveBeenCalled();
      if (failure === 'rejected')
        expect(logger.warn).toHaveBeenCalledWith(
          'Requested video could not be loaded',
          expect.objectContaining({ postId: 'a' }),
        );
      await render({ readTarget: jest.fn(async () => A) });
      await act(async () => result.refresh());
      expect(result.posts[0]).toEqual(A);
      expect(result.hasLoadError).toBe(false);
    },
  );

  it('preserves selection when existing data is reordered or another item is inserted', async () => {
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await act(async () => result.selectIndex(1));
    await act(async () => result.setPosts([C, A, B]));
    expect(result.currentVisibleIndex).toBe(2);
    expect(result.posts[result.currentVisibleIndex]).toEqual(B);
    await act(async () => result.setPosts((posts) => [item('inserted'), ...posts]));
    expect(result.currentVisibleIndex).toBe(3);
    expect(result.posts[result.currentVisibleIndex]).toEqual(B);
  });

  it('deduplicates pagination requests and keeps media identity through duplicate pages', async () => {
    const next = deferred<{ items: Item[]; hasMore: boolean }>();
    options.readPage = jest.fn(async (_feed, cursor) =>
      cursor ? next.promise : { items: [B], hasMore: true, nextCursor: 'page-2' },
    );
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    let read = Promise.resolve();
    await act(async () => {
      read = result.loadMore();
      void result.loadMore();
    });
    expect(options.readPage).toHaveBeenCalledTimes(2);
    await act(async () => {
      next.resolve({ items: [item('a', 1), C], hasMore: false });
      await read;
    });
    expect(result.posts).toEqual([A, B, C]);
    expect(result.currentVisibleIndex).toBe(0);
    expect(result.loadingMore).toBe(false);
  });

  it('uses the public feed when a Following viewer signs out', async () => {
    await render();
    await act(async () => result.selectFeed('following'));
    await render({ signedOut: true, viewerId: undefined });
    expect(result.activeFeed).toBe('videos');
    expect(options.readPage).toHaveBeenLastCalledWith('videos', undefined);
  });

  it('keeps the selected video when a later ranked page fails', async () => {
    options.readPage = jest.fn(async (_feed, cursor) => {
      if (cursor) throw new Error('offline');
      return { items: [B, C], hasMore: true, nextCursor: 'next' };
    });
    await render({ target: { postId: 'a', mediaIndex: 0 } });
    await act(async () => result.selectIndex(1));
    await act(async () => result.loadMore());
    expect(result.hasLoadError).toBe(true);
    expect(result.loadingMore).toBe(false);
    expect(result.posts[result.currentVisibleIndex]).toEqual(B);
    await act(async () => result.loadMore());
    expect(options.readPage).toHaveBeenCalledTimes(2);
  });

  it('ignores a rejected target belonging to an obsolete navigation', async () => {
    const old = deferred<Item>();
    await render({ target: { postId: 'a' }, readTarget: () => old.promise });
    await render({ target: { postId: 'c' }, readTarget: async () => C });
    await act(async () => old.reject(new Error('old request failed')));
    expect(result.posts[0]).toEqual(C);
    expect(result.hasLoadError).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not publish a ranked response after unmount', async () => {
    const pending = deferred<{ items: Item[] }>();
    await render({ readPage: () => pending.promise });
    const mounted = renderer;
    await act(async () => mounted?.unmount());
    renderer = undefined;
    await act(async () => pending.resolve({ items: [B] }));
    expect(options.cachePosts).not.toHaveBeenCalled();
  });
});
