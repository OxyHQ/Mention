import type { ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import WatchRoute from '../[id]';

let mockPending = true;
let mockAccessFailed = false;

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isPending: mockPending }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ isAuthResolved: true }),
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/lib/navigation/router', () => ({
  useLocalSearchParams: () => ({ id: 'video-1' }),
  useRouter: () => ({}),
}));
jest.mock('@/hooks/usePostReadAccess', () => ({
  usePostReadAccess: () => ({ allowed: !mockAccessFailed, failed: mockAccessFailed }),
}));
jest.mock('@/stores/postsStore', () => ({ usePostsStore: () => jest.fn() }));
jest.mock('@/components/common/VideoPlayer', () => () => null);
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
