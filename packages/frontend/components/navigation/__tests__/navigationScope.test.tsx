import TestRenderer, { act } from 'react-test-renderer';

const mockAuth = {
  user: { id: 'viewer-a', username: 'reader' },
  isAuthResolved: true,
  canUsePrivateApi: true,
};
const mockSession = { activeSessionId: 'session-a' };
let mockScope: string;

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => mockAuth,
  useOxy: () => mockSession,
}));
jest.mock('@oxy.so/bloom/tab-pager/expo-router', () => ({
  TabPagerProvider: ({ navigationScopeKey }: { navigationScopeKey: string }) => {
    mockScope = navigationScopeKey;
    return null;
  },
}));
jest.mock('@/components/ui/AccountAvatar', () => ({ AccountAvatar: () => null }));
jest.mock('@oxy.so/bloom/hooks', () => ({ useHaptics: () => jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => 0 }));
jest.mock('@/hooks/useCommunitiesPreview', () => ({ useCommunitiesPreview: () => false }));
jest.mock('@/components/settings/settingsRoutes', () => ({ requestSettings: jest.fn() }));

import { MentionNavigation } from '../MentionNavigation';

it('invalidates navigation transactions on a new session of the same viewer', () => {
  const mounted: { tree?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    mounted.tree = TestRenderer.create(<MentionNavigation>{null}</MentionNavigation>);
  });
  const tree = mounted.tree;
  if (!tree) throw new Error('Navigation fixture did not mount');
  const firstSession = mockScope;
  mockSession.activeSessionId = 'session-b';
  act(() => {
    tree.update(<MentionNavigation>{null}</MentionNavigation>);
  });
  expect(mockScope).not.toBe(firstSession);
  const secondSession = mockScope;
  act(() => {
    tree.update(<MentionNavigation>{null}</MentionNavigation>);
  });
  expect(mockScope).toBe(secondSession);
  mockAuth.canUsePrivateApi = false;
  act(() => {
    tree.update(<MentionNavigation>{null}</MentionNavigation>);
  });
  expect(mockScope).not.toBe(secondSession);
  act(() => tree.unmount());
});
