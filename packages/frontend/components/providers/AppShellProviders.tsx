import { memo, type ReactNode } from 'react';
import { VideosRailProvider } from '@/context/VideosRailContext';
import { VideoPlaybackProvider } from '@/context/VideoPlaybackContext';
import { DrawerProvider } from '@/context/DrawerContext';
import { MentionNavigation } from '@/components/navigation/MentionNavigation';
import { ScreenReselectProvider } from '@/context/ScreenReselectContext';
import { CommunityNoteProvider } from './CommunityNoteProvider';

/**
 * App-shell contexts owned by Mention. Everything Bloom owns — theme, haptics,
 * image resolution, scroll restoration, the navigation chrome and its minimize
 * on scroll — comes from the single `<BloomProvider>` in
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
            {/* What pressing the place already in front means: above the
                navigation, whose bar and sidebar both reselect through it. */}
            <ScreenReselectProvider>
              {/* Mention's destinations, declared once: Bloom's pager, bar and
                  sidebar draw from them. Above the tabs layout, because the bar
                  renders over pushed detail routes too. */}
              <MentionNavigation>
                {/* One answer for the whole shell to "can a note be written
                    here", so a feed page's rows read it instead of each asking. */}
                <CommunityNoteProvider>{children}</CommunityNoteProvider>
              </MentionNavigation>
            </ScreenReselectProvider>
          </DrawerProvider>
        </VideoPlaybackProvider>
      </VideosRailProvider>
    </>
  );
});
