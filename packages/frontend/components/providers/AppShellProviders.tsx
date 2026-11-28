// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { memo, type ReactNode } from 'react';
import { VideoPlaybackProvider } from '@oxy.so/bloom/video-playback';
import { MentionNavigation } from '@/components/navigation/MentionNavigation';
import { useAgeProtections } from '@/hooks/useAgeProtections';
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
  // A minor's account never autoplays (oxy ADR 0068): video and animated media
  // start when the person plays them. `undefined` leaves it to the person's own
  // setting, so nobody else's choice is overridden.
  const { autoplay } = useAgeProtections();
  // One playback authority for the whole app: only a visible, focused,
  // foregrounded player may play, and only one may be audible.
  return (
    <VideoPlaybackProvider autoplay={autoplay === 'never' ? false : undefined}>
      {/* Mention's destinations, declared once: Bloom's pager, bar and
              sidebar draw from them. Above the tabs layout, because the bar
              renders over pushed detail routes too. */}
      <MentionNavigation>
        {/* One answer for the whole shell to "can a note be written
                here", so a feed page's rows read it instead of each asking. */}
        <CommunityNoteProvider>{children}</CommunityNoteProvider>
      </MentionNavigation>
    </VideoPlaybackProvider>
  );
});
