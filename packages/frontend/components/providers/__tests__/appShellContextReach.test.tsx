import type React from 'react';
import { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import type { OxyServices } from '@oxy.so/core';

import { AppProviders } from '../AppProviders';
import { presentSheet } from '@/utils/sheet';
import { useVideoPlayback } from '@oxy.so/bloom/video-playback';
import { useVideosRail } from '@/context/VideosRailContext';
import { usePostInteractions, type PostInteractions } from '@/components/Feed/postInteractions';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

/**
 * Content authored inside the app shell must RENDER inside it.
 *
 * Two surfaces render content at a position far above where its JSX was written,
 * and React resolves context by render position, not by authoring position:
 *
 * - Bloom's `<SurfaceHost />` renders every presented sheet beside its own
 *   siblings. A `<GifPickerSheet/>` presented by
 *   `components/Compose/ComposeScreen.tsx` therefore mounts wherever that HOST
 *   sits, not where compose sits.
 * - Bloom's NATIVE portal group re-registers `<Portal>` children onto its
 *   `<Outlet/>`, which `app/_layout.tsx` mounts beside `<AuthRouter/>`. (Bloom's
 *   WEB portal is `ReactDOM.createPortal`, which does preserve context, so that
 *   half is native-only.)
 *
 * Both land at the `AppProviders` level, so every app-shell context has to be
 * mounted ABOVE the surface host and above `AppProviders`' own children —
 * not down in `app/(app)/_layout.tsx` where only routed screens can see it.
 *
 * These tests pin that. They render the REAL `AppProviders` and assert from the
 * two positions that actually bit us. Move `AppShellProviders` back inside
 * `(app)/_layout` and the first case fails with the exact production error,
 * "useVideoPlayback must be used inside a <VideoPlaybackProvider>".
 */

// Only the leaves that need a host environment are mocked. Every provider whose
// NESTING this test is about — AppShellProviders and the surface host's place
// in AppProviders — is the real one.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// The root status bar reads Bloom's theme; production mounts AppProviders inside BloomProvider.
jest.mock('@oxy.so/bloom/theme', () => ({
  ...jest.requireActual('@oxy.so/bloom/theme'),
  useTheme: () => ({ isDark: false }),
}));
jest.mock('@oxy.so/services/ui/one-video', () => ({ OxyOneVideo: () => null }));
jest.mock('@alia.onl/sdk/avatar', () => ({ AliaAvatarIcon: () => null }));

// The boot visual AppProviders hands to AccountSwitchReset as its `fallback`.
// A leaf like the others above: it reaches straight into Bloom's ESM-only theme
// and preset-vars entries, which have no host environment here. Its CONTENT is
// irrelevant to context reach — what this suite pins is the provider nesting.
jest.mock('@/components/AppSplashScreen', () => ({
  __esModule: true,
  default: () => null,
}));

// Reanimated's real entry pulls in the worklets native module, which has no host
// here; a minimal stub.
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedReaction: () => {},
  // `TabPagerProvider` settles the bar's highlight onto whatever tab the route
  // ended up on. Nothing here looks at the motion; it just has to be callable.
  withSpring: (value: number) => value,
}));

jest.mock('expo-router', () => ({
  useRouter: () => jest.requireMock('expo-router').router,
  usePathname: () => '/',
  useIsFocused: () => true,
  // `TabPagerProvider` reads the router imperatively to pop anything pushed
  // over the tabs before switching. Nothing here selects a tab, so these are
  // only present so the module resolves.
  router: { canDismiss: () => false, dismissAll: () => {}, navigate: () => {}, prefetch: () => {} },
}));

jest.mock('@oxy.so/services/ui/client', () => ({
  OxyProvider: ({ children }: { children: React.ReactNode }) => children,
  // `TabPagerProvider` needs the viewer's handle to recognise `/@<own handle>`
  // as the profile tab (on web `/you` redirects there). Signed out is the
  // simplest true state for a shell-shape test.
  useAuth: () => ({ user: undefined, isAuthResolved: true, canUsePrivateApi: false }),
  useOxy: () => ({ activeSessionId: null }),
}));

jest.mock('react-i18next', () => ({
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/lib/i18n', () => ({ __esModule: true, default: {} }));

// Passthrough on purpose: the boundary sits between the two probe positions, and
// a real one would swallow the very throw these tests assert on, turning a
// precise "no VideoPlaybackProvider" failure into a silent fallback render.
jest.mock('@/components/AppErrorBoundary', () => ({
  AppErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/components/providers/AccountSwitchReset', () => ({
  AccountSwitchReset: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/context/LiveRoomContext', () => ({
  LiveRoomControllerProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// The binder resolves the session SDK and the menu's services; the controller it
// binds INTO is the real one, and that is what the reach case below pins.
jest.mock('@/components/Feed/PostInteractionsBinder', () => ({
  PostInteractionsBinder: () => null,
}));
jest.mock('@/hooks/usePostShare', () => ({ sharePost: jest.fn() }));
jest.mock('@/stores/postsStore', () => ({ usePostsStore: { getState: () => ({}) } }));
jest.mock('@/components/Fediverse/FediverseInfoDialog', () => ({
  FediverseInfoDialogProvider: () => null,
}));
jest.mock('@/components/Channels/ChannelInfoDialog', () => ({
  ChannelInfoDialogProvider: () => null,
}));
jest.mock('@/components/providers/LiveFeatureProviders', () => ({ LiveFeatureHost: () => null }));
jest.mock('@/components/providers/LivePresencePoller', () => ({ LivePresencePoller: () => null }));
/**
 * Pass-through, like the siblings above: this provider resolves the
 * community-note handlers, which reaches the API client and the Oxy session SDK
 * — neither of which a shell-SHAPE test should be booting. What it hands down is
 * covered by `hooks/__tests__/useCommunityNotes.test.tsx`.
 */
jest.mock('@/components/providers/CommunityNoteProvider', () => ({
  CommunityNoteProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mention's destinations run for real — every hook they call must be reachable
// from where the navigation is mounted — over a pass-through Bloom provider,
// which Bloom's own tests cover.
jest.mock('@oxy.so/bloom/tab-pager/expo-router', () => ({
  TabPagerProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => 0 }));

// Bloom's surface stack, minus the Dialog: the host draws each presented
// surface inline where it is mounted. The sheet's React POSITION — the only
// thing under test — is identical either way: on native Bloom's portal group
// re-parents the Dialog onto the outlet at this same depth, and on web it is
// `createPortal`, which preserves the host's context.
jest.mock('@oxy.so/bloom/surfaces', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  let stack: ((surface: unknown) => React.ReactNode)[] = [];
  const listeners = new Set<() => void>();
  const surface = { dismiss: () => {}, present: () => Promise.resolve() };
  return {
    present: (render: (surface: unknown) => React.ReactNode) => {
      stack = [...stack, render];
      for (const listener of listeners) listener();
      return new Promise(() => {});
    },
    SurfaceHost: () => {
      const entries = R.useSyncExternalStore(
        (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => stack,
      );
      return entries.map((render, index) =>
        R.createElement(R.Fragment, { key: index }, render(surface)),
      );
    },
    __reset: () => {
      stack = [];
    },
  };
});

// Every app a case renders is unmounted after it: a host left mounted would
// draw the next case's sheets too.
const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
  jest.requireMock<{ __reset: () => void }>('@oxy.so/bloom/surfaces').__reset();
});

const oxyServices = {} as OxyServices;

function renderApp(children: React.ReactNode): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <AppProviders oxyServices={oxyServices} queryClient={new QueryClient()} onAskAlia={() => {}}>
        {children}
      </AppProviders>,
    );
  });
  if (!renderer) throw new Error('renderer was not created');
  mounted.push(renderer);
  return renderer;
}

/** Presents `content` as a sheet from inside the app tree, exactly as a routed screen does. */
function SheetPusher({ content }: { content: React.ReactNode }) {
  useEffect(() => {
    void presentSheet(() => content);
  }, [content]);
  return null;
}

describe('app-shell contexts reach hoisted content', () => {
  it('lets sheet content use the video playback authority', () => {
    // The reported crash: compose hands the GIF picker to the sheet, the picker
    // renders a <VideoPlayer/>, and the player asks for the playback authority.
    const GifPickerLikeContent = () => {
      useVideoPlayback({ id: 'gif-preview' });
      return null;
    };

    expect(() => renderApp(<SheetPusher content={<GifPickerLikeContent />} />)).not.toThrow();
  });

  it('lets content at the portal-outlet position use the video playback authority', () => {
    // `app/_layout.tsx` mounts <PortalOutlet/> among AppProviders' children, so
    // anything bloom's native portal group re-parents lands at this depth.
    const PortalledContent = () => {
      useVideoPlayback({ id: 'portalled-player' });
      return null;
    };

    expect(() => renderApp(<PortalledContent />)).not.toThrow();
  });

  it('gives sheet content and the app tree the SAME app-shell context instance', () => {
    // Every app-shell context except VideoPlayback has a default value, so a
    // consumer mounted outside the provider reads a silent no-op instead of
    // throwing. Identity is the only way to catch that: write the videos rail
    // from the app tree and require the sheet to observe it.
    let sheetSawOpen: boolean | undefined;

    const SheetProbe = () => {
      sheetSawOpen = useVideosRail().active;
      return null;
    };

    const RailWriter = () => {
      const { setRailState } = useVideosRail();
      useEffect(() => {
        setRailState({ active: true });
      }, [setRailState]);
      return null;
    };

    renderApp(
      <>
        <RailWriter />
        <SheetPusher content={<SheetProbe />} />
      </>,
    );

    expect(sheetSawOpen).toBe(true);
  });

  it('gives a post rendered in a sheet the app post-interaction controller', () => {
    // Feed rows issue every command through one controller (#1103). The sheet
    // renders its content at the surface host's depth, so a post shown
    // in a sheet only reaches the controller if its provider sits above that —
    // below it, the row would silently get the unbound fallback.
    let fromTree: PostInteractions | undefined;
    let fromSheet: PostInteractions | undefined;
    let outsideApp: PostInteractions | undefined;

    const TreeProbe = () => {
      fromTree = usePostInteractions();
      return null;
    };
    const SheetProbe = () => {
      fromSheet = usePostInteractions();
      return null;
    };
    const OutsideProbe = () => {
      outsideApp = usePostInteractions();
      return null;
    };

    renderApp(
      <>
        <TreeProbe />
        <SheetPusher content={<SheetProbe />} />
      </>,
    );
    act(() => {
      TestRenderer.create(<OutsideProbe />);
    });

    expect(fromSheet).toBeDefined();
    expect(fromSheet).toBe(fromTree);
    expect(fromSheet).not.toBe(outsideApp);
  });
});
