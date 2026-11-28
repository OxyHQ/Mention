import type { ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import WatchRoute from '../[id]';
import WatchHomeRoute from '../index';

let mockPending = true;
let mockAccessFailed = false;
const mockVideos = {
  hasNextPage: true,
  isFetching: false,
  isError: false,
  fetchNextPage: jest.fn(),
};
let mockEndReached: (() => void) | undefined;
let mockSelectClips: (() => void) | undefined;

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isPending: mockPending }),
  useInfiniteQuery: () => mockVideos,
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ isAuthResolved: true }),
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => children,
  ScreenScrollView: ({
    children,
    onEndReached,
  }: {
    children: ReactNode;
    onEndReached?: () => void;
  }) => {
    mockEndReached = onEndReached;
    return children;
  },
}));
jest.mock('@oxy.so/bloom/chip', () => ({
  Chip: ({ children, onPress }: { children: string; onPress: () => void }) => {
    if (children === 'videos.clips') mockSelectClips = onPress;
    return null;
  },
  ChipRow: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/skeleton', () => ({
  Region: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/lib/navigation/router', () => ({
  useIsFocused: () => true,
  useLocalSearchParams: () => ({ id: 'video-1' }),
  useRouter: () => ({}),
}));
jest.mock('@oxy.so/bloom/panel-routing', () => ({ useOptionalPanelRouter: () => null }));
jest.mock('@/components/deck/useDeckAvailable', () => ({ useDeckAvailable: () => false }));
jest.mock('@/components/deck/deckSettings', () => ({ useDeckSettings: () => false }));
jest.mock('@/hooks/usePostReadAccess', () => ({
  usePostReadAccess: () => ({ allowed: !mockAccessFailed, failed: mockAccessFailed }),
}));
jest.mock('@/stores/postsStore', () => ({ usePostsStore: () => jest.fn() }));
jest.mock('@/components/common/VideoPlayer', () => () => null);
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/services/feedService', () => ({ feedService: {} }));
jest.mock('@/components/videos/VideoPreviewCard', () => ({
  VideoPreviewCard: () => null,
  VideoPreviewGrid: () => null,
  VideoPreviewSkeleton: () => null,
}));
jest.mock('@/components/videos/VideoSuggestions', () => ({ VideoRecommendations: () => null }));
jest.mock('@/components/videos/WatchVideoDetails', () => ({
  WatchVideoDetails: () => null,
  usePublishWatchDetails: () => undefined,
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({
  WatchVideoSkeleton: () => {
    const { View } = require('react-native');
    return <View testID="watch-video-skeleton" />;
  },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }),
}));

it('keeps the skeleton during access and post loading and replaces it with the unavailable state on failure', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<WatchRoute />);
  });
  expect(JSON.stringify(tree.toJSON())).toContain('watch-video-skeleton');

  // A rejected access check must surface the failure even with a disabled, pending query.
  mockAccessFailed = true;
  act(() => tree.update(<WatchRoute />));
  expect(JSON.stringify(tree.toJSON())).toContain('videos.unavailable');
  expect(JSON.stringify(tree.toJSON())).not.toContain('watch-video-skeleton');

  mockAccessFailed = false;
  mockPending = false;
  act(() => tree.update(<WatchRoute />));
  expect(JSON.stringify(tree.toJSON())).toContain('videos.unavailable');
  act(() => tree.unmount());
});

it('loads the next catalog page from the scroll boundary and pauses while fetching or browsing clips', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<WatchHomeRoute />);
  });
  act(() => mockEndReached?.());
  expect(mockVideos.fetchNextPage).toHaveBeenCalledTimes(1);
  expect(mockVideos.fetchNextPage).toHaveBeenCalledWith({ cancelRefetch: false });

  mockVideos.isFetching = true;
  act(() => tree.update(<WatchHomeRoute />));
  expect(mockEndReached).toBeUndefined();

  mockVideos.isFetching = false;
  act(() => tree.update(<WatchHomeRoute />));
  expect(mockEndReached).toBeDefined();
  act(() => mockSelectClips?.());
  expect(mockEndReached).toBeUndefined();

  act(() => tree.unmount());
});
