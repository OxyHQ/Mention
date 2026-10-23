import { memo, type ReactNode } from 'react';
import { VideosRailProvider } from '@/context/VideosRailContext';
import { VideoPlaybackProvider } from '@/context/VideoPlaybackContext';
import { DrawerProvider } from '@/context/DrawerContext';
import { BottomBarVisibilityProvider } from '@/context/BottomBarVisibilityContext';
import { MentionTabPager } from '@/components/navigation/MentionTabPager';
import { CommunityNoteProvider } from './CommunityNoteProvider';

/**
 * App-shell contexts owned by Mention. Everything Bloom owns — theme, haptics,
 * image resolution, scroll restoration, and the tab-bar minimize progress the
 * BottomBar reads — comes from the single `<BloomProvider>` in
 * `app/_layout.tsx`, which sits above this whole tree.
 */
export const AppShellProviders = memo(function AppShellProviders({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <VideosRailProvider>
        {/* one playback authority for the whole (app) group: only a visible,
            focused, foregrounded player may play, and only one may be audible */}
        <VideoPlaybackProvider>
          <DrawerProvider>
            {/* Bloom's tab pager: which root page is in front and where the
                bar's highlight sits. Above the tabs layout, because the bar
                renders over pushed detail routes too. */}
            <MentionTabPager>
              {/* shared bottom-bar auto-hide signal, pinned visible on /videos */}
              <BottomBarVisibilityProvider>
                {/* One answer for the whole shell to "can a note be written
                    here", so a feed page's rows read it instead of each asking. */}
                <CommunityNoteProvider>{children}</CommunityNoteProvider>
              </BottomBarVisibilityProvider>
            </MentionTabPager>
          </DrawerProvider>
        </VideoPlaybackProvider>
      </VideosRailProvider>
    </>
  );
});
