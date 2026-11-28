import type { ReactNode } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

const mockRefetch = jest.fn();
let mockQuery: {
  isPending: boolean;
  isError: boolean;
  data?: { items: Array<{ id: string; name: string }> };
  refetch: () => void;
};
let mockCanUsePrivateApi = true;

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => mockQuery,
  useMutation: () => ({ mutate: jest.fn() }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'u1' }, canUsePrivateApi: mockCanUsePrivateApi }),
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { warn: jest.fn() } }));
jest.mock('@/lib/viewerQueryKeys', () => ({ viewerQueryKeys: { feedInterstitial: () => ['k'] } }));
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/services/starterPacksService', () => ({
  starterPacksService: { list: jest.fn(), use: jest.fn() },
}));
jest.mock('@/components/FollowButton', () => ({
  FollowButton: () => {
    const { Text } = require('react-native');
    return <Text>follow-button</Text>;
  },
}));
jest.mock('@/components/StarterPackCard', () => {
  const { Text } = require('react-native');
  return {
    StarterPackCard: ({ footer }: { footer: ReactNode }) => (
      <>
        <Text>pack-card</Text>
        {footer}
      </>
    ),
    StarterPackCardSkeleton: () => null,
    starterPackCardData: (pack: unknown) => pack,
    starterPackId: (pack: { id: string }) => pack.id,
  };
});
jest.mock('@oxy.so/bloom/card', () => {
  const pass = ({ children }: { children?: ReactNode }) => children;
  return { CardHeader: pass, CardBody: pass, CardTitle: pass, CardDescription: pass };
});
jest.mock('@oxy.so/bloom/grid', () => ({
  ResponsiveGrid: ({ children }: { children?: ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/typography', () => ({
  Muted: ({ children }: { children?: ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => {
    const { Text } = require('react-native');
    return <Text onPress={onPress}>{children}</Text>;
  },
}));

import { WelcomeStarterPacks } from '../WelcomeStarterPacks';

function render(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<WelcomeStarterPacks />);
  });
  return renderer;
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe('WelcomeStarterPacks', () => {
  beforeEach(() => {
    mockCanUsePrivateApi = true;
    mockRefetch.mockClear();
    mockQuery = {
      isPending: false,
      isError: false,
      data: { items: [{ id: 'p1', name: 'Pack one' }] },
      refetch: mockRefetch,
    };
  });

  it('shows each pack with a follow button for a signed-in viewer', () => {
    const renderer = render();
    expect(text(renderer)).toContain('pack-card');
    expect(text(renderer)).toContain('follow-button');
    expect(text(renderer)).not.toContain('welcome.people.signInToFollow');
  });

  it('asks a visitor to sign in instead of offering a follow button', () => {
    mockCanUsePrivateApi = false;
    const renderer = render();
    expect(text(renderer)).toContain('welcome.people.signInToFollow');
    expect(text(renderer)).not.toContain('follow-button');
  });

  it('shows a load error with a retry that asks for the packs again', () => {
    mockQuery = { isPending: false, isError: true, refetch: mockRefetch };
    const renderer = render();
    expect(text(renderer)).toContain('welcome.people.loadError');
    const retry = renderer.root.findAll(
      (node) => typeof node.props.onPress === 'function' && node.props.children === 'common.retry',
    )[0];
    act(() => retry.props.onPress());
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('draws nothing when there are no packs and no error', () => {
    mockQuery = { isPending: false, isError: false, data: { items: [] }, refetch: mockRefetch };
    expect(render().toJSON()).toBeNull();
  });
});
