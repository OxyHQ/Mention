jest.mock('@oxy.so/bloom/agent-avatar', () => ({
  parseAvatarCharacter: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).parseAvatarCharacter,
  useAvatarRendererCapabilities: () => ({ sharedLiveRendering: true }),
}));
import TestRenderer, { act } from 'react-test-renderer';

import { CommunityPanel } from '../CommunityPanel';

/**
 * What a community's page offers: posting in it, hosted here or remote; its
 * moderators only for one hosted here; and the way into its settings only to them.
 */

const mockPush = jest.fn();
const mockModerators = jest.fn((_id: string | null | undefined) => ({
  data: [{ id: 'mod-1', username: 'mod', name: { displayName: 'Mod' }, avatar: null }],
}));
const mockOperates = jest.fn(
  (_params: { accountId: string | null | undefined; accountKind: string }) => true,
);

jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ canUsePrivateApi: true }),
}));
jest.mock('@/hooks/useCommunities', () => ({
  useCommunityModerators: (id: string | null | undefined) => mockModerators(id),
}));
jest.mock('@/components/Profile/hooks/useOperatesAccount', () => ({
  useOperatesAccount: (params: { accountId: string | null | undefined; accountKind: string }) =>
    mockOperates(params),
}));
jest.mock('@oxy.so/bloom/avatar-group', () => ({ AvatarGroup: 'AvatarGroup' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null) => user?.username ?? null,
}));

function labels(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => (node.type as unknown) === 'Button')
    .map((node) => String(node.props.children));
}

describe('CommunityPanel', () => {
  it('lets anyone post, and only moderators of a community hosted here reach its settings', () => {
    let hosted!: TestRenderer.ReactTestRenderer;
    act(() => {
      hosted = TestRenderer.create(
        <CommunityPanel communityId="forum-1" username="forum" hosted />,
      );
    });
    expect(labels(hosted)).toEqual(['Post in this community', 'communities.settings.edit']);
    const buttons = hosted.root.findAll((node) => (node.type as unknown) === 'Button');
    act(() => {
      for (const button of buttons) button.props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith('/compose?community=forum-1');
    expect(mockPush).toHaveBeenCalledWith('/@forum/settings');
    const group = hosted.root.findAll((node) => (node.type as unknown) === 'AvatarGroup')[0];
    act(() => group.props.onPressItem({ id: 'mod-1' }));
    expect(mockPush).toHaveBeenCalledWith('/@mod');

    // A remote community: post in it, nothing to moderate from here.
    mockModerators.mockClear();
    let remote!: TestRenderer.ReactTestRenderer;
    act(() => {
      remote = TestRenderer.create(
        <CommunityPanel communityId="lemmy-1" username="lemmy@lemmy.world" hosted={false} />,
      );
    });
    expect(labels(remote)).toEqual(['Post in this community']);
    expect(mockModerators).toHaveBeenCalledWith(null);
    expect(mockOperates).toHaveBeenLastCalledWith({ accountId: null, accountKind: 'community' });
  });
});
