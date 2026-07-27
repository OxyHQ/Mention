import React, { memo, type ReactNode } from 'react';
import { ScreenColorProvider } from '@/context/ScreenColorContext';
import { VideosRailProvider } from '@/context/VideosRailContext';
import { ActiveVideoProvider } from '@/context/ActiveVideoContext';
import { DrawerProvider } from '@/context/DrawerContext';
import { BottomBarVisibilityProvider } from '@/context/BottomBarVisibilityContext';
import { TabBarMinimizeProvider } from '@oxyhq/bloom/tab-bar';

export const AppShellProviders = memo(function AppShellProviders({ children }: { children: ReactNode }) {
  return (
    <ScreenColorProvider>
      <VideosRailProvider>
        {/* one "only the on-screen video plays" coordinator for the whole (app) group */}
        <ActiveVideoProvider>
          <DrawerProvider>
            {/* Bloom's tab-bar minimize progress. MUST stay ABOVE
                BottomBarVisibilityProvider (which writes it) and above the bar
                itself (which reads it) so both share ONE state. Moved any lower and
                `useMinimizeState()` silently hands each of them a private local
                fallback value — the bar then never minimizes, with no error
                anywhere. Do not "tidy" this down the tree. */}
            <TabBarMinimizeProvider>
              {/* shared bottom-bar auto-hide signal, pinned visible on /videos */}
              <BottomBarVisibilityProvider>
                {children}
              </BottomBarVisibilityProvider>
            </TabBarMinimizeProvider>
          </DrawerProvider>
        </ActiveVideoProvider>
      </VideosRailProvider>
    </ScreenColorProvider>
  );
});
