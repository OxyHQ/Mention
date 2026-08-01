import React, { useContext, useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import type { OxyServices } from '@oxyhq/core';

import { AppProviders } from '../AppProviders';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useVideoPlayback } from '@/context/VideoPlaybackContext';
import { useDrawer } from '@/context/DrawerContext';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

/**
 * Content authored inside the app shell must RENDER inside it.
 *
 * Two surfaces render content at a position far above where its JSX was written,
 * and React resolves context by render position, not by authoring position:
 *
 * - `BottomSheetProvider` parks whatever `setBottomSheetContent` is handed in
 *   state and renders it beside its own children. A `<GifPickerSheet/>` built by
 *   `app/(app)/compose.tsx` therefore mounts wherever that PROVIDER sits, not
 *   where compose sits.
 * - Bloom's NATIVE portal group re-registers `<Portal>` children onto its
 *   `<Outlet/>`, which `app/_layout.tsx` mounts beside `<AuthRouter/>`. (Bloom's
 *   WEB portal is `ReactDOM.createPortal`, which does preserve context, so that
 *   half is native-only.)
 *
 * Both land at the `AppProviders` level, so every app-shell context has to be
 * mounted ABOVE `BottomSheetProvider` and above `AppProviders`' own children —
 * not down in `app/(app)/_layout.tsx` where only routed screens can see it.
 *
 * These tests pin that. They render the REAL `AppProviders` and assert from the
 * two positions that actually bit us. Move `AppShellProviders` back inside
 * `(app)/_layout` and the first case fails with the exact production error,
 * "useVideoPlayback must be used inside a <VideoPlaybackProvider>".
 */

// Only the leaves that need a host environment are mocked. Every provider whose
// NESTING this test is about — AppShellProviders, BottomSheetProvider,
// LayoutScrollProvider — is the real one.
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

jest.mock('react-native-popup-menu', () => ({
  MenuProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

// Reanimated's real entry pulls in the worklets native module, which has no host
// here. Same minimal stub the LayoutScroll/BottomBarVisibility suites use.
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedReaction: () => {},
}));

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  useIsFocused: () => true,
}));

jest.mock('@oxyhq/services/ui/client', () => ({
  OxyProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('react-i18next', () => ({
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
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

jest.mock('@/components/common/ConfirmPrompt', () => ({ ConfirmPromptProvider: () => null }));
jest.mock('@/components/common/ActionMenu', () => ({ ActionMenuHost: () => null }));
jest.mock('@/components/common/ContentDialog', () => ({ ContentDialogHost: () => null }));
jest.mock('@/components/Fediverse/FediverseInfoDialog', () => ({
  FediverseInfoDialogProvider: () => null,
}));
jest.mock('@/components/providers/LiveFeatureProviders', () => ({ LiveFeatureHost: () => null }));

jest.mock('@oxyhq/bloom/tab-bar', () => ({
  useMinimizeState: () => ({ minimized: { value: 0 } }),
  setMinimized: () => {},
}));

// Renders its children inline instead of behind present/dismiss. The sheet's
// React POSITION — the only thing under test — is identical either way: on
// native the real sheet is an RN <Modal>, which keeps its children in the React
// tree, and on web it is `createPortal`, which preserves context too.
jest.mock('@oxyhq/bloom/bottom-sheet', () => ({
  BottomSheet: ({ children }: { children: React.ReactNode }) => children,
}));

const oxyServices = {} as OxyServices;

function renderApp(children: React.ReactNode): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <AppProviders oxyServices={oxyServices} queryClient={new QueryClient()}>
        {children}
      </AppProviders>,
    );
  });
  if (!renderer) throw new Error('renderer was not created');
  return renderer;
}

/** Pushes `content` into the bottom sheet from inside the app tree, exactly as a routed screen does. */
function SheetPusher({ content }: { content: React.ReactNode }) {
  const { setBottomSheetContent } = useContext(BottomSheetContext);
  useEffect(() => {
    setBottomSheetContent(content);
  }, [setBottomSheetContent, content]);
  return null;
}

describe('app-shell contexts reach hoisted content', () => {
  it('lets bottom-sheet content use the video playback authority', () => {
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
    // throwing. Identity is the only way to catch that: open the drawer from the
    // app tree and require the sheet to observe it.
    let sheetSawOpen: boolean | undefined;

    const SheetProbe = () => {
      sheetSawOpen = useDrawer().isOpen;
      return null;
    };

    const DrawerOpener = () => {
      const { open } = useDrawer();
      useEffect(() => {
        open();
      }, [open]);
      return null;
    };

    renderApp(
      <>
        <DrawerOpener />
        <SheetPusher content={<SheetProbe />} />
      </>,
    );

    expect(sheetSawOpen).toBe(true);
  });
});
