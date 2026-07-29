import React, { memo, type ReactNode } from 'react';
import { ScreenColorProvider } from '@/context/ScreenColorContext';
import { VideosRailProvider } from '@/context/VideosRailContext';
import { VideoPlaybackProvider } from '@/context/VideoPlaybackContext';
import { DrawerProvider } from '@/context/DrawerContext';
import { BottomBarVisibilityProvider } from '@/context/BottomBarVisibilityContext';

/**
 * App-shell contexts owned by Mention. Everything Bloom owns — theme, haptics,
 * image resolution, scroll restoration, and the tab-bar minimize progress the
 * BottomBar reads — comes from the single `<BloomProvider>` in
 * `app/_layout.tsx`, which sits above this whole tree.
 */
export const AppShellProviders = memo(function AppShellProviders({ children }: { children: ReactNode }) {
  return (
    <ScreenColorProvider>
      <VideosRailProvider>
        {/* one playback authority for the whole (app) group: only a visible,
            focused, foregrounded player may play, and only one may be audible */}
        <VideoPlaybackProvider>
          <DrawerProvider>
            {/* shared bottom-bar auto-hide signal, pinned visible on /videos */}
            <BottomBarVisibilityProvider>
              {children}
            </BottomBarVisibilityProvider>
          </DrawerProvider>
        </VideoPlaybackProvider>
      </VideosRailProvider>
    </ScreenColorProvider>
  );
});
