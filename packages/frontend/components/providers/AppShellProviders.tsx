import React, { memo, type ReactNode } from 'react';
import { ScreenColorProvider } from '@/context/ScreenColorContext';
import { VideosRailProvider } from '@/context/VideosRailContext';
import { ActiveVideoProvider } from '@/context/ActiveVideoContext';
import { DrawerProvider } from '@/context/DrawerContext';
import { BottomBarVisibilityProvider } from '@/context/BottomBarVisibilityContext';

export const AppShellProviders = memo(function AppShellProviders({ children }: { children: ReactNode }) {
  return (
    <ScreenColorProvider>
      <VideosRailProvider>
        {/* one "only the on-screen video plays" coordinator for the whole (app) group */}
        <ActiveVideoProvider>
          <DrawerProvider>
            {/* shared bottom-bar auto-hide signal, pinned visible on /videos */}
            <BottomBarVisibilityProvider>
              {children}
            </BottomBarVisibilityProvider>
          </DrawerProvider>
        </ActiveVideoProvider>
      </VideosRailProvider>
    </ScreenColorProvider>
  );
});
