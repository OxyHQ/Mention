import type { ReactElement, ReactNode } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Button } from '@oxy.so/bloom/button';
import { Image } from 'expo-image';
import type { HydratedPost } from '@mention/shared-types';
import type { TFunction } from 'i18next';
import PostActions from '@/components/Post/PostActions';
import { CompactReplyComposer } from '@/components/Post/CompactReplyComposer';
import { FollowButton } from '@/components/FollowButton';
import { Link } from '@/lib/navigation/router';
import { VideoPreviewCard, VideoPreviewGrid, VideoPreviewSkeleton } from '../VideoPreviewCard';
import {
  VideoRecommendations,
  VideoSuggestions,
  usePublishVideoSuggestions,
} from '../VideoSuggestions';
import { WatchVideoDetails, WatchVideoRail, usePublishWatchDetails } from '../WatchVideoDetails';
import { watchVideo } from '../watchVideo';

const mockCommands = {
  requireSession: jest.fn(),
  toggleLike: jest.fn(),
  toggleDownvote: jest.fn(),
  toggleSave: jest.fn(),
  toggleRepost: jest.fn(),
  share: jest.fn(),
  sendInAllo: jest.fn(),
};
const mockPush = jest.fn();
const mockRepostMenu = jest.fn();
const mockFeed = jest.fn();
const mockRefetch = jest.fn();
const mockGetVideos = jest.fn();
let mockCached: HydratedPost | undefined;
let mockUser: { id: string } | undefined;
let mockAuthResolved = true;
let mockLanguage: string | undefined;
let mockQueryOptions: { enabled: boolean; queryFn: (context: { signal: AbortSignal }) => unknown };
let mockQueryResult: { data?: { items: HydratedPost[] }; isPending?: boolean; isError?: boolean };

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: typeof mockQueryOptions) => {
    mockQueryOptions = options;
    return { ...mockQueryResult, refetch: mockRefetch };
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: mockUser, isAuthResolved: mockAuthResolved }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: { defaultValue?: string; formattedCount?: string; count?: number },
    ) =>
      options?.formattedCount ? `${options.formattedCount} views` : (options?.defaultValue ?? key),
    i18n: { resolvedLanguage: mockLanguage, language: 'en' },
  }),
}));
jest.mock('@/stores/postsStore', () => ({ usePostSelector: () => mockCached }));
jest.mock('@/services/feedService', () => ({
  feedService: { getMtnFeed: (...args: unknown[]) => mockGetVideos(...args) },
}));
jest.mock('@/components/Feed/postInteractions', () => ({
  usePostInteractions: () => mockCommands,
}));
jest.mock('@/components/Feed/showRepostMenu', () => ({
  showRepostMenu: (args: unknown) => mockRepostMenu(args),
}));
jest.mock('@/components/Feed/Feed', () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockFeed(props);
    return null;
  },
}));
jest.mock('@/components/FollowButton', () => ({ FollowButton: () => null }));
jest.mock('@/components/Post/PostActions', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/CompactReplyComposer', () => ({ CompactReplyComposer: () => null }));
jest.mock('@/components/common/VideoPlayer', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/common/LinkifiedText', () => ({
  LinkifiedText: ({ text }: { text: string }) => text,
}));
jest.mock('@/lib/navigation/router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/skeleton', () => ({ Box: () => null }));

const t = ((key: string) => key) as TFunction;
const horizontal = {
  id: 'horizontal',
  type: 'video' as const,
  url: 'https://media.example.test/horizontal.mp4',
  posterUrl: 'https://media.example.test/horizontal.jpg',
  width: 1280,
  height: 720,
  durationSec: 65,
};

function post(id = 'watch', overrides: Partial<HydratedPost> = {}) {
  return {
    id,
    user: { id: 'author', username: 'alice', name: { displayName: 'Alice' } },
    content: { title: 'Train ride', text: 'Landscape footage #travel', media: [horizontal] },
    attachments: {},
    viewerState: {},
    engagement: { replies: 0, likes: 1, views: 1234 },
    metadata: { createdAt: '2024-02-01T12:00:00Z' },
    ...overrides,
  } as HydratedPost;
}

let tree: ReactTestRenderer | undefined;

function render(element: ReactElement) {
  act(() => {
    if (tree) tree.update(element);
    else tree = TestRenderer.create(element);
  });
  if (!tree) throw new Error('Watch screen did not render');
  return tree.root;
}

function output() {
  return JSON.stringify(tree?.toJSON());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCommands.requireSession.mockReturnValue(true);
  mockCached = undefined;
  mockUser = undefined;
  mockAuthResolved = true;
  mockLanguage = 'en';
  mockQueryResult = {};
  jest.useFakeTimers({ now: new Date('2024-02-04T12:00:00Z') });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  jest.useRealTimers();
});

it('shows readable titles, live counts and expanded descriptions in the Watch rail', () => {
  const video = post('video', {
    content: {
      title: 'Ride with [@Alice](alice@example.test)',
      text: 'Start\nFollow the train\nStop at the bridge\nEnd of the route',
    },
  });
  mockCached = { ...video, engagement: { ...video.engagement, views: 89 } };
  const Scene = ({ enabled }: { enabled: boolean }) => {
    usePublishWatchDetails(video, enabled);
    return <WatchVideoRail />;
  };

  render(<Scene enabled={false} />);
  expect(tree?.toJSON()).toBeNull();
  const root = render(<Scene enabled />);
  expect(output()).toContain('Ride with Alice');
  expect(output()).toContain('89 views · 3 days ago');
  expect(root.findByType(Link).props.href).toBe('/@alice');
  expect(root.findByType(FollowButton).props.userId).toBe('author');
  expect(output()).toContain('Show more');
  const descriptionToggle = () =>
    root.findAll(
      (item) =>
        item.props.accessibilityState?.expanded != null && typeof item.props.onPress === 'function',
    )[0];
  expect(descriptionToggle()?.props.accessibilityState.expanded).toBe(false);
  act(() => descriptionToggle()?.props.onPress());
  expect(output()).toContain('February 1, 2024');
  expect(output()).toContain('Show less');
  act(() => descriptionToggle()?.props.onPress());
  expect(output()).not.toContain('February 1, 2024');

  render(<Scene enabled={false} />);
  expect(tree?.toJSON()).toBeNull();
});

it('connects Watch actions and opens replies only on demand', () => {
  const video = post();
  mockUser = { id: 'author' };
  const root = render(<WatchVideoDetails post={video} />);
  const actions = root.findByType(PostActions).props;
  expect(root.findAllByType(FollowButton)).toHaveLength(0);
  expect(mockFeed).not.toHaveBeenCalled();
  mockCommands.requireSession.mockReturnValue(false);
  expect(actions.onLike()).toBe(false);
  actions.onRepost();
  expect(mockRepostMenu).not.toHaveBeenCalled();

  mockCommands.requireSession.mockReturnValue(true);
  expect(actions.onLike()).toBe(true);
  actions.onDownvote();
  actions.onRepost();
  actions.onSave();
  actions.onShare();
  actions.onSendInAllo();
  const [{ onRepost, onQuote }] = mockRepostMenu.mock.lastCall as [
    { onRepost: () => void; onQuote: () => void },
  ];
  onRepost();
  onQuote();
  expect(mockCommands.toggleLike).toHaveBeenCalledWith(video, 'videos');
  expect(mockCommands.toggleDownvote).toHaveBeenCalledWith(video);
  expect(mockCommands.toggleRepost).toHaveBeenCalledWith(video, 'videos');
  expect(mockCommands.toggleSave).toHaveBeenCalledWith(video, 'videos');
  expect(mockCommands.share).toHaveBeenCalledWith(video);
  expect(mockCommands.sendInAllo).toHaveBeenCalledWith(video.id);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/compose',
    params: { quotePostId: video.id },
  });

  act(() => actions.onReply());
  expect(root.findByType(CompactReplyComposer).props.postId).toBe(video.id);
  expect(mockFeed).toHaveBeenCalledWith(
    expect.objectContaining({ filters: { postId: video.id, parentPostId: video.id } }),
  );
  act(() => root.findByType(Button).props.onPress());
  expect(root.findAllByType(CompactReplyComposer)).toHaveLength(0);
});

it('handles missing metadata and readers who can open existing replies but cannot write them', () => {
  mockLanguage = undefined;
  const video = post('archived', {
    content: {},
    user: {} as HydratedPost['user'],
    metadata: { createdAt: 'invalid', replyPermission: ['nobody'] } as HydratedPost['metadata'],
    engagement: { replies: 4 } as HydratedPost['engagement'],
  });
  const root = render(<WatchVideoDetails post={video} />);
  expect(output()).toContain('Video');
  expect(output()).not.toContain('watch-video-metadata');
  expect(root.findAllByType(Link)).toHaveLength(0);
  act(() => root.findByType(PostActions).props.onReply());
  expect(output()).toContain('watch-video-replies');
  expect(root.findAllByType(CompactReplyComposer)).toHaveLength(0);

  const closed = { ...video, engagement: { ...video.engagement, replies: null } };
  const closedRoot = render(<WatchVideoDetails key="closed" post={closed} />);
  expect(closedRoot.findByType(PostActions).props.onReply).toBeUndefined();
});

it('requests horizontal recommendations for the current video and sorts related posts first', () => {
  const current = post();
  mockUser = { id: 'reader' };
  const unrelated = post('unrelated', {
    user: { id: 'bob', username: 'bob' } as HydratedPost['user'],
    content: { title: 'Different topic', media: [horizontal] },
  });
  const related = post('related', {
    content: { title: 'Mountain train', text: '#TRAVEL', media: [horizontal] },
  });
  const portrait = post('portrait', {
    content: { media: [{ ...horizontal, width: 720, height: 1280 }] },
  });
  const hidden = post('sensitive', {
    content: { media: [{ ...horizontal, durationSec: undefined }] },
    user: {} as HydratedPost['user'],
    metadata: { ...current.metadata, isSensitive: true, createdAt: 'invalid' },
    engagement: { ...current.engagement, views: null },
  });
  mockQueryResult = { data: { items: [current, unrelated, portrait, related, hidden] } };
  const root = render(<VideoRecommendations current={current} columns={2} />);
  expect(mockQueryOptions.enabled).toBe(true);
  const { signal } = new AbortController();
  mockQueryOptions.queryFn({ signal });
  expect(mockGetVideos).toHaveBeenCalledWith('videos', {
    limit: 16,
    orientation: 'landscape',
    signal,
  });
  expect(root.findAllByType(Link).map((item) => item.props.href.params.id)).toEqual([
    'related',
    'unrelated',
    'sensitive',
  ]);
  expect(root.findAllByType(Image)).toHaveLength(2);
  expect(output()).toContain('1:05');

  render(<VideoRecommendations current={current} />);
  expect(root.findAllByType(Link)).toHaveLength(3);
});

it('keeps the suggestions rail idle without an active post and supports empty, loading, and retry', () => {
  const current = post();
  const Rail = ({ enabled }: { enabled: boolean }) => {
    usePublishVideoSuggestions(current, enabled);
    return <VideoSuggestions />;
  };
  mockAuthResolved = false;
  mockQueryResult = { isPending: true };
  const root = render(<Rail enabled={false} />);
  expect(mockQueryOptions.enabled).toBe(false);
  expect(output()).not.toContain('No horizontal videos');

  mockAuthResolved = true;
  mockQueryResult = { data: { items: [] } };
  render(<Rail enabled />);
  expect(mockQueryOptions.enabled).toBe(true);
  expect(output()).toContain('No horizontal videos');

  mockQueryResult = { isError: true };
  render(<Rail enabled />);
  act(() => root.findByType(Button).props.onPress());
  expect(mockRefetch).toHaveBeenCalledTimes(1);
});

it('routes landscape cards to Watch and clips to the feed while keeping titles and artwork readable', () => {
  const video = watchVideo(post(), null);
  const clip = video && {
    ...video,
    mediaIndex: 2,
    post: post('clip', {
      content: { text: 'A short clip' },
      user: { id: 'bob', username: 'bob' } as HydratedPost['user'],
      metadata: { ...video.post.metadata, isSensitive: true, createdAt: 'invalid' },
    }),
  };
  const untitled = video && {
    ...video,
    poster: undefined,
    duration: undefined,
    post: post('untitled', {
      content: {},
      user: {} as HydratedPost['user'],
      metadata: { ...video.post.metadata, createdAt: 'invalid' },
      engagement: { ...video.post.engagement, views: null },
    }),
  };
  if (!video || !clip || !untitled) throw new Error('Expected playable fixtures');
  const root = render(
    <>
      <VideoPreviewGrid
        columns={2}
        cards={[
          <VideoPreviewCard key="video" video={video} locale="en" t={t} />,
          <VideoPreviewCard key="clip" video={clip} clip locale="en" t={t} />,
          <VideoPreviewCard key="untitled" video={untitled} locale="en" t={t} />,
        ]}
      />
      <VideoPreviewSkeleton />
      <VideoPreviewSkeleton clip />
    </>,
  );
  expect(root.findAllByType(Link).map((item) => item.props.href)).toEqual([
    { pathname: '/watch/[id]', params: { id: 'watch', mediaIndex: '0' } },
    { pathname: '/videos', params: { postId: 'clip', mediaIndex: '2' } },
    { pathname: '/watch/[id]', params: { id: 'untitled', mediaIndex: '0' } },
  ]);
  expect(root.findAllByType(Image)).toHaveLength(1);
  expect(output()).toContain('A short clip');
  expect(output()).toContain('videos.reel');
});
