import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { Text } from '@oxy.so/bloom/typography';
import { FollowingAvatars } from './FollowingAvatars';
import type { VideoFeedTab } from '@/hooks/useVideoFeed';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const useTextStyles = createTokenStyles(() => ({
  tab: { fontSize: 18, lineHeight: 28, fontWeight: '600', color: 'rgba(255, 255, 255, 0.6)' },
  tabSelected: { color: '#ffffff' },
}));

interface VideoFeedTabsProps {
  value: VideoFeedTab;
  onValueChange: (value: VideoFeedTab) => void;
}

/** Plain labels over the video; the parent header owns its safe-area and scrim. */
export function VideoFeedTabs({ value, onValueChange }: VideoFeedTabsProps) {
  const textStyles = useTextStyles();
  const { t } = useTranslation();
  return (
    <View accessibilityRole="tablist" className="flex-row items-center justify-center gap-5">
      {(['videos', 'following'] as const).map((tab) => (
        <PressableScale
          key={tab}
          accessibilityRole="tab"
          aria-selected={value === tab}
          onPress={() => onValueChange(tab)}
          style={{
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
          testID={`video-feed-tab-${tab}`}
        >
          <Text style={[textStyles.tab, value === tab && textStyles.tabSelected]}>
            {t(tab === 'videos' ? 'videos.tabs.forYou' : 'videos.tabs.following')}
          </Text>
          {tab === 'following' && <FollowingAvatars />}
        </PressableScale>
      ))}
    </View>
  );
}
