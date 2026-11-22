import { useTranslation } from 'react-i18next';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
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
      Embed(
        (['videos', 'following'] as const).map((tab) => (
          <PressableScale
            key={tab}
            accessibilityRole="tab"
            aria-selected={value === tab}
            onPress={() => onValueChange(tab)}
            className="min-h-11 flex-row items-center justify-center gap-1.5"
            testID={`video-feed-tab-${tab}`}
          >
            {toElement(
              LText(t(tab === 'videos' ? 'videos.tabs.forYou' : 'videos.tabs.following'))
                .font('18')
                .leading('28px')
                .weight('semibold')
                .foreground(value === tab ? 'white' : 'white/60'),
            )}
            {tab === 'following' && <FollowingAvatars />}
          </PressableScale>
        )),
      ),
    )
      .align('center')
      .justify('center')
      .spacing('xl')
      .role('tablist'),
  );
}
