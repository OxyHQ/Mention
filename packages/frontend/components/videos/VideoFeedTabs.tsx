import { useTranslation } from 'react-i18next';
import { FollowingAvatars } from './FollowingAvatars';
import type { VideoFeedTab } from '@/hooks/useVideoFeed';

import { Embed, HStack, Text as LText, toElement } from '@oxy.so/bloom-language';

interface VideoFeedTabsProps {
  value: VideoFeedTab;
  onValueChange: (value: VideoFeedTab) => void;
}

/** Plain labels over the video; the parent header owns its safe-area and scrim. */
export function VideoFeedTabs({ value, onValueChange }: VideoFeedTabsProps) {
  const { t } = useTranslation();
  return toElement(
    HStack(
      (['videos', 'following'] as const).map((tab) =>
        // Bloom's PressableScale, announced as a tab and selected (aria-selected on the web).
        HStack(
          LText(t(tab === 'videos' ? 'videos.tabs.forYou' : 'videos.tabs.following'))
            .font('18')
            .leading('28px')
            .weight('semibold')
            .foreground(value === tab ? 'white' : 'white/60'),
          tab === 'following' ? Embed(<FollowingAvatars />) : null,
        )
          .frame({ minHeight: '44' })
          .align('center')
          .justify('center')
          .spacing('6')
          .pressScale()
          .role('tab')
          .accessibilityState({ selected: value === tab })
          .onPress(() => onValueChange(tab))
          .testID(`video-feed-tab-${tab}`)
          .id(tab),
      ),
    )
      .align('center')
      .justify('center')
      .spacing('xl')
      .role('tablist'),
  );
}
