import { memo } from 'react';
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';
import { LIVE_INDICATOR_COLOR } from '@/styles/colors';

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

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${room.title}, ${room.status}`}
      disabled={!onPress}
      onPress={onPress}
      style={[
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.card,
          borderWidth: 1,
          borderRadius: 16,
          padding: variant === 'compact' ? 12 : 16,
        },
        style,
      ]}
    >
      <View className="flex-row items-center gap-3">
        <View
          className="items-center justify-center rounded-full"
          style={{
            width: variant === 'compact' ? 34 : 40,
            height: variant === 'compact' ? 34 : 40,
            backgroundColor: live
              ? LIVE_INDICATOR_COLOR
              : theme.colors.backgroundSecondary,
          }}
        >
          <Ionicons
            name={live ? 'radio' : 'calendar-outline'}
            size={variant === 'compact' ? 17 : 20}
            color={live ? '#fff' : theme.colors.text}
          />
        </View>
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
          <Ionicons
            name="chevron-forward"
            size={18}
            color={theme.colors.textSecondary}
          />
        ) : null}
      </View>
    </Pressable>
  );
});

export default RoomCard;
