import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { Text } from '@oxy.so/bloom/typography';
import { FollowingAvatars } from './FollowingAvatars';
import type { VideoFeedTab } from '@/hooks/useVideoFeed';

interface VideoFeedTabsProps {
  value: VideoFeedTab;
  onValueChange: (value: VideoFeedTab) => void;
}

/** Plain labels over the video; the parent header owns its safe-area and scrim. */
export function VideoFeedTabs({ value, onValueChange }: VideoFeedTabsProps) {
  const { t } = useTranslation();
  return (
    <View accessibilityRole="tablist" className="flex-row items-center justify-center gap-5">
      {(['videos', 'following'] as const).map((tab) => (
        <PressableScale
          key={tab}
          accessibilityRole="tab"
          aria-selected={value === tab}
          onPress={() => onValueChange(tab)}
          className="min-h-11 flex-row items-center justify-center gap-1.5"
          testID={`video-feed-tab-${tab}`}
        >
          <Text
            className={`text-lg font-semibold ${value === tab ? 'text-white' : 'text-white/60'}`}
          >
            {t(tab === 'videos' ? 'videos.tabs.forYou' : 'videos.tabs.following')}
          </Text>
          {tab === 'following' && <FollowingAvatars />}
        </PressableScale>
      ))}
    </View>
  );
}
