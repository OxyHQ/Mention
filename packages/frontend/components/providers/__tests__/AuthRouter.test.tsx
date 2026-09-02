/**
 * The root's boot gate.
 *
 * Two invariants, and they pull in opposite directions — which is exactly why
 * both are pinned here:
 *
 *  1. While auth is unresolved the tree must render SOMETHING. Rendering
 *     nothing during boot is a blank screen with no console output; on a
 *     returning viewer whose warm access token has expired, the SDK's
 *     device-secret mint is a real network round-trip, so that window is
 *     bounded only by the 12s cold-boot deadline.
 *  2. While auth is unresolved the (auth)↔(app) swap must NOT run. This is the
 *     sole authority for that swap, and acting on unresolved state lands the
 *     viewer on a blank or wrong route.
 *
 * Satisfying (1) by dropping the guard would break (2); satisfying (2) by
 * returning null breaks (1).
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useAuth } from '@oxyhq/services/ui/client';
import { Slot } from 'expo-router';
import AppSplashScreen from '@/components/AppSplashScreen';
import { AuthRouter } from '../AuthRouter';

let mockIsAuthResolved = false;
let mockIsAuthenticated = false;
let mockSegments: string[] = [];

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React2 = jest.requireActual<typeof import('react')>('react');
  const MockSlot = () => React2.createElement('MockSlot');
  const MockStack = Object.assign(
    ({ children }: { children?: React.ReactNode }) =>
      React2.createElement('MockStack', null, children),
    { Screen: () => React2.createElement('MockStackScreen') },
  );
  return {
    Slot: MockSlot,
    Stack: MockStack,
    Redirect: ({ href }: { href: string }) => React2.createElement('MockRedirect', { href }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useSegments: () => mockSegments,
    usePathname: () => '/',
  };
});

// The splash is the boot visual under test — stubbed to a recognisable host
// element so its PRESENCE is asserted against the real output tree rather than
// a spy (a spy that is never wired cannot distinguish success from failure).
jest.mock('@/components/AppSplashScreen', () => {
  const React2 = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: () => React2.createElement('MockSplash') };
});

// Mounted for side effects only. None participates in the gate, and all of it
// would otherwise reach the network, storage or native modules.
jest.mock('@/hooks/useServerAppearanceSync', () => ({ useServerAppearanceSync: jest.fn() }));
jest.mock('@/hooks/useAccountTheme', () => ({ useAccountThemeSync: jest.fn() }));
jest.mock('@/hooks/useViewerFollowing', () => ({ useSeedViewerFollowStatuses: jest.fn() }));
jest.mock('@/stores/externalEmbedsStore', () => ({ useHydrateExternalEmbeds: jest.fn() }));
jest.mock('@/lib/shareIntent', () => ({ useShareIntentRouter: jest.fn() }));
jest.mock('@/lib/webTelemetry', () => ({ recordWebNavigation: jest.fn() }));

const mockUseAuth = useAuth as jest.Mock;

const has = (renderer: TestRenderer.ReactTestRenderer, type: React.ElementType) =>
  renderer.root.findAllByType(type).length > 0;

const render = () => {
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<AuthRouter />);
  });
  return renderer!;
};

describe('AuthRouter boot gate', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mockIsAuthResolved = false;
    mockIsAuthenticated = false;
    mockSegments = [];
    jest.clearAllMocks();
    mockUseAuth.mockImplementation(() => ({
      isAuthResolved: mockIsAuthResolved,
      isAuthenticated: mockIsAuthenticated,
    }));
  });

  it('renders the boot visual, not nothing, while auth is unresolved', () => {
    const renderer = render();

    expect(renderer.toJSON()).not.toBeNull();
    expect(has(renderer, AppSplashScreen)).toBe(true);

    act(() => {
      renderer.unmount();
    });
  });

  it('does not run the (auth)/(app) swap until auth resolves', () => {
    const renderer = render();

    // Unresolved: no router surface of any kind is mounted, on either platform,
    // so nothing can navigate or redirect off unresolved state.
    expect(has(renderer, Slot)).toBe(false);

    mockIsAuthResolved = true;
    act(() => {
      renderer.update(<AuthRouter />);
    });

    // Resolved: the swap runs and the boot visual is gone.
    expect(has(renderer, Slot)).toBe(true);
    expect(has(renderer, AppSplashScreen)).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('does not redirect an authenticated viewer out of (auth) before auth resolves', () => {
    // The redirect leg of the swap, specifically: `isAuthenticated` can read
    // false-y simply because the boot has not finished, so a viewer sitting on
    // an (auth) route must not be bounced on that unresolved reading either.
    mockSegments = ['(auth)'];
    mockIsAuthenticated = true;

    const renderer = render();

    expect(renderer.root.findAllByProps({ href: '/' }).length).toBe(0);
    expect(has(renderer, AppSplashScreen)).toBe(true);

    act(() => {
      renderer.unmount();
    });
  });

  it('redirects an authenticated viewer out of (auth) after auth resolves', () => {
    mockSegments = ['(auth)'];
    mockIsAuthenticated = true;
    mockIsAuthResolved = true;

    const renderer = render();

    expect(renderer.toJSON()).toMatchObject({ type: 'MockRedirect', props: { href: '/' } });
    expect(has(renderer, AppSplashScreen)).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });
});
