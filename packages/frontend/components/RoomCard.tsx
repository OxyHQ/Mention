import { memo } from 'react';
import {
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { LIVE_INDICATOR_COLOR, LIVE_INDICATOR_FOREGROUND_COLOR } from '@/styles/colors';

export interface RoomCardData {
  _id: string;
  title: string;
  status: 'scheduled' | 'live' | 'ended';
  topic?: string | null;
  participants?: string[];
  host: string;
}

interface RoomCardProps {
  room: RoomCardData;
  variant?: 'default' | 'compact';
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * Lightweight room preview. Audio/LiveKit stays behind the route-level Syra
 * provider and is loaded only after this card is activated.
 */
const RoomCard = memo(function RoomCard({
  room,
  variant = 'default',
  onPress,
  style,
}: RoomCardProps) {
  const theme = useTheme();
  const live = room.status === 'live';
  const listeners = room.participants?.length ?? 0;
  const compact = variant === 'compact';
  const disc = compact ? 34 : 40;

  return (
    <Card
      variant="outlined"
      radius="radius-16"
      onPress={onPress}
      accessibilityLabel={`${room.title}, ${room.status}`}
      style={[{ padding: compact ? 12 : 16 }, style]}
    >
      <View className="flex-row items-center gap-3">
        {/* A live room's disc is the fixed live signal; any other state sits on
            the quiet secondary surface. Both halves of the pair are overridden
            together, as `IconCircle` asks. */}
        <IconCircle
          icon={live ? RiBroadcastLine : RiCalendarLine}
          size={compact ? 'sm' : 'md'}
          style={{
            width: disc,
            height: disc,
            backgroundColor: live ? LIVE_INDICATOR_COLOR : theme.colors.backgroundSecondary,
          }}
          iconStyle={{ color: live ? LIVE_INDICATOR_FOREGROUND_COLOR : theme.colors.text }}
        />
        <View className="flex-1">
          <Text
            className="font-semibold text-foreground"
            numberOfLines={1}
          >
            {room.title}
          </Text>
          <Text
            className="mt-0.5 text-xs text-muted-foreground"
            numberOfLines={1}
          >
            {live ? `${listeners} listening` : room.status}
            {room.topic ? ` · ${room.topic}` : ''}
          </Text>
        </View>
        {onPress ? (
          <RiArrowRightSLine width={18} height={18} fill={theme.colors.textSecondary} />
        ) : null}
      </View>
    </Card>
  );
});

export default RoomCard;
