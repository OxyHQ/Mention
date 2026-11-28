import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { logger } from '@oxy.so/core/logger';
import { loadVideoPagesUntilProgress } from '@/utils/video-feed-pagination';

export type VideoFeedTab = 'videos' | 'following';
export interface VideoTarget {
  postId: string;
  mediaIndex?: number;
  mediaId?: string;
}
interface VideoIdentity {
  id: string;
  mediaIndex: number;
  mediaId?: string;
}
interface VideoPage<T> {
  items: T[];
  hasMore?: boolean;
  nextCursor?: string;
}
interface Options<T> {
  target: VideoTarget | null;
  focused: boolean;
  navigationEntry: unknown;
  viewerId?: string;
  signedOut: boolean;
  readTarget: (target: VideoTarget) => Promise<T | null>;
  readPage: (feed: VideoFeedTab, cursor?: string) => Promise<VideoPage<T>>;
  cachePosts: (posts: T[]) => void;
  resetScroll: () => void;
}
interface Session {
  id: number;
  feed: VideoFeedTab;
  entry: number;
  viewerId?: string;
  reload: number;
  landing: VideoTarget | null;
}
interface ReadSession {
  owner: Session;
  shown: Set<string>;
  busy: boolean;
}
interface FeedState<T> {
  owner: Session;
  posts: T[];
  selectedKey: string | null;
  isLoading: boolean;
  hasLoadError: boolean;
  hasMore: boolean;
  nextCursor?: string;
  loadingMore: boolean;
}
const emptyFeed = <T>(owner: Session): FeedState<T> => ({
  owner,
  posts: [],
  selectedKey: null,
  isLoading: true,
  hasLoadError: false,
  hasMore: true,
  loadingMore: false,
});
const identity = (item: VideoIdentity) =>
  JSON.stringify([item.id, item.mediaId ?? item.mediaIndex]);
const targetKey = (target: VideoTarget | null) =>
  target ? JSON.stringify([target.postId, target.mediaIndex]) : null;

/** Route intent owns the landing; ranked pages can only extend that session. */
export function useVideoFeed<T extends VideoIdentity>(options: Options<T>) {
  const incomingKey = targetKey(options.target);
  const [navigation, setNavigation] = useState(() => ({
    observedKey: incomingKey,
    observedEntry: options.navigationEntry,
    target: options.target,
    feed: 'videos' as VideoFeedTab,
    entry: 0,
  }));
  if (
    options.focused &&
    (navigation.observedKey !== incomingKey || navigation.observedEntry !== options.navigationEntry)
  ) {
    setNavigation({
      ...navigation,
      observedKey: incomingKey,
      observedEntry: options.navigationEntry,
      ...(options.target
        ? { target: options.target, feed: 'videos', entry: navigation.entry + 1 }
        : {}),
    });
  } else if (options.signedOut && navigation.feed === 'following') {
    setNavigation({ ...navigation, feed: 'videos', target: null, entry: navigation.entry + 1 });
  }

  const [reload, setReload] = useState(0);
  const [state, setState] = useState<FeedState<T>>(() =>
    emptyFeed({
      id: 1,
      feed: navigation.feed,
      entry: navigation.entry,
      viewerId: options.viewerId,
      reload,
      landing: navigation.target,
    }),
  );
  if (
    state.owner.entry !== navigation.entry ||
    state.owner.viewerId !== options.viewerId ||
    state.owner.reload !== reload
  ) {
    const selected = state.posts.find((post) => identity(post) === state.selectedKey);
    const viewerChanged =
      state.owner.entry === navigation.entry && state.owner.viewerId !== options.viewerId;
    const landing =
      viewerChanged && selected
        ? { postId: selected.id, mediaIndex: selected.mediaIndex, mediaId: selected.mediaId }
        : state.hasLoadError && state.owner.entry === navigation.entry
          ? state.owner.landing
          : navigation.target;
    setState(
      emptyFeed({
        id: state.owner.id + 1,
        feed: navigation.feed,
        entry: navigation.entry,
        viewerId: options.viewerId,
        reload,
        landing,
      }),
    );
  }
  const latest = useRef({ options, state });
  useEffect(() => {
    latest.current = { options, state };
  });
  const session = useRef<ReadSession | null>(null);
  const updateSession = useCallback(
    (owner: Session, update: (previous: FeedState<T>) => FeedState<T>) => {
      setState((previous) => (previous.owner === owner ? update(previous) : previous));
    },
    [],
  );

  const readPages = useCallback(
    async (owner: NonNullable<typeof session.current>, cursor?: string) => {
      await loadVideoPagesUntilProgress(async (nextCursor) => {
        try {
          const page = await latest.current.options.readPage(owner.owner.feed, nextCursor);
          if (session.current !== owner) return null;
          const added = page.items.filter((post) => {
            if (owner.shown.has(post.id)) return false;
            owner.shown.add(post.id);
            return true;
          });
          if (added.length) latest.current.options.cachePosts(added);
          updateSession(owner.owner, (previous) => ({
            ...previous,
            posts: added.length ? [...previous.posts, ...added] : previous.posts,
            selectedKey: previous.selectedKey ?? (added[0] ? identity(added[0]) : null),
            hasLoadError: false,
            hasMore: Boolean(page.hasMore),
            nextCursor: page.nextCursor,
          }));
          return { added: added.length, hasMore: page.hasMore, nextCursor: page.nextCursor };
        } catch {
          if (session.current !== owner) return null;
          updateSession(owner.owner, (previous) => ({
            ...previous,
            hasLoadError: true,
            hasMore: false,
          }));
          return null;
        }
      }, cursor);
    },
    [updateSession],
  );

  useEffect(() => {
    const owner: ReadSession = { owner: state.owner, shown: new Set(), busy: false };
    session.current = owner;
    const landing = state.owner.landing;
    latest.current.options.resetScroll();
    void (async () => {
      if (landing) {
        let post: T | null = null;
        try {
          post = await latest.current.options.readTarget(landing);
        } catch (error) {
          if (session.current !== owner) return;
          logger.warn('Requested video could not be loaded', { postId: landing.postId, error });
        }
        if (session.current !== owner) return;
        if (!post || post.id !== landing.postId) {
          updateSession(owner.owner, (previousState) => ({
            ...previousState,
            isLoading: false,
            hasLoadError: true,
            hasMore: false,
          }));
          return;
        }
        owner.shown.add(post.id);
        updateSession(owner.owner, (previousState) => ({
          ...previousState,
          posts: [post],
          selectedKey: identity(post),
        }));
      }
      await readPages(owner);
      if (session.current === owner)
        updateSession(owner.owner, (previousState) => ({ ...previousState, isLoading: false }));
    })();
    return () => {
      if (session.current === owner) session.current = null;
    };
  }, [state.owner, readPages, updateSession]);

  const loadMore = useCallback(async () => {
    const owner = session.current;
    const current = latest.current.state;
    if (!owner || owner.busy || current.isLoading || !current.hasMore || !current.nextCursor)
      return;
    owner.busy = true;
    updateSession(owner.owner, (previous) => ({ ...previous, loadingMore: true }));
    try {
      await readPages(owner, current.nextCursor);
    } finally {
      owner.busy = false;
      if (session.current === owner)
        updateSession(owner.owner, (previous) => ({ ...previous, loadingMore: false }));
    }
  }, [readPages, updateSession]);
  const selectPost = useCallback(
    (post: T) => {
      if (session.current?.owner !== state.owner) return;
      const key = identity(post);
      updateSession(state.owner, (previous) =>
        previous.posts.some((item) => identity(item) === key)
          ? { ...previous, selectedKey: key }
          : previous,
      );
    },
    [state.owner, updateSession],
  );
  // A delayed pager callback belongs to the list it rendered, not a newer index.
  const selectIndex = useCallback(
    (index: number) => {
      const post = state.posts[index];
      if (post) selectPost(post);
    },
    [state.posts, selectPost],
  );
  const setPosts = useCallback((update: SetStateAction<T[]>) => {
    setState((previous) => ({
      ...previous,
      posts: typeof update === 'function' ? update(previous.posts) : update,
    }));
  }, []);
  const selectFeed = useCallback((feed: VideoFeedTab) => {
    setNavigation((previous) =>
      previous.feed === feed
        ? previous
        : {
            ...previous,
            feed,
            target: null,
            entry: previous.entry + 1,
          },
    );
  }, []);
  const refresh = useCallback(() => setReload((previous) => previous + 1), []);
  return {
    ...state,
    setPosts,
    selectPost,
    selectIndex,
    loadMore,
    refresh,
    selectFeed,
    sessionId: state.owner.id,
    activeFeed: navigation.feed,
    target: navigation.target,
    currentVisibleIndex: Math.max(
      0,
      state.posts.findIndex((post) => identity(post) === state.selectedKey),
    ),
  };
}
