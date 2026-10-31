import TestRenderer, { act } from 'react-test-renderer';
import type { AvatarIdentitySummary } from '@mention/shared-types';
import { FeedCard } from '../FeedCard';
import { StarterPackCard } from '../StarterPackCard';

jest.mock('@oxy.so/bloom/agent-avatar', () => ({
  parseAvatarCharacter: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).parseAvatarCharacter,
  useAvatarRendererCapabilities: () => ({ sharedLiveRendering: true }),
}));
jest.mock('@oxy.so/bloom/avatar-group', () => ({ AvatarGroup: 'AvatarGroup' }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: 'Avatar' }));
jest.mock('@oxy.so/bloom/card', () => ({ Card: 'Card' }));
jest.mock('@oxy.so/bloom/icon-circle', () => ({ IconCircle: 'IconCircle' }));
jest.mock('@oxy.so/bloom/pressable-scale', () => ({ PressableScale: 'PressableScale' }));
jest.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));
jest.mock('@oxy.so/bloom/skeleton', () => ({ Box: 'SkeletonBox' }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { card: '#fff' } }) }));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: null }) }));
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/components/ProfileHoverCard', () => ({ ProfileHoverCard: 'ProfileHoverCard' }));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string }) => user.username,
}));

const character = {
  shape: 'circle_two_ears',
  color: 'lime',
  eyes: 'oval',
  eyewear: 'none',
  accessory: 'none',
} as const;
const bot: AvatarIdentitySummary = {
  id: 'bot',
  username: 'agent',
  name: { displayName: 'Agent' },
  kind: 'bot',
  character,
};

it.each(['feed', 'pack'] as const)(
  '%s facepile retains a bot without a photo and legacy URL compatibility',
  (kind) => {
    let tree: TestRenderer.ReactTestRenderer;
    const render = (memberProfiles?: AvatarIdentitySummary[]) =>
      kind === 'feed' ? (
        <FeedCard
          feed={{
            id: 'feed',
            displayName: 'Feed',
            memberProfiles,
            memberAvatars: ['legacy-photo'],
          }}
        />
      ) : (
        <StarterPackCard
          pack={{
            id: 'pack',
            name: 'Pack',
            memberCount: 1,
            useCount: 0,
            memberProfiles,
            memberAvatars: ['legacy-photo'],
          }}
        />
      );
    act(() => {
      tree = TestRenderer.create(render([bot]));
    });
    const group = () => tree.root.findByType('AvatarGroup' as unknown as React.ComponentType);
    expect(group().props.motion).toBe('always');
    expect(group().props.items).toEqual([
      {
        id: 'bot',
        kind: 'bot',
        character,
        uri: undefined,
        displayName: 'Agent',
        username: 'agent',
      },
    ]);
    act(() => tree.update(render()));
    expect(group().props.items).toHaveLength(1);
    expect(group().props.items[0].uri).toBe('legacy-photo');
    act(() => tree.unmount());
  },
);
