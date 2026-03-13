import React from 'react';
import { TouchableOpacity, View, Text, StyleProp, ViewStyle } from 'react-native';

interface PostAttachmentEventProps {
  name: string;
  date: string; // ISO date string or Date object
  location?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

const PostAttachmentEvent: React.FC<PostAttachmentEventProps> = ({
  name,
  date,
  location,
  onPress,
  style
}) => {
  // Parse date and format
  const eventDate = React.useMemo(() => {
    try {
      const d = typeof date === 'string' ? new Date(date) : date;
      if (isNaN(d.getTime())) return null;
      return d;
    } catch {
      return null;
    }
  }, [date]);

  const day = eventDate ? eventDate.getDate() : null;
  const month = eventDate ? eventDate.toLocaleString('default', { month: 'short' }) : null;
  const year = eventDate ? eventDate.getFullYear() : null;
  const time = eventDate ? eventDate.toLocaleTimeString('default', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }) : null;

  return (
    <TouchableOpacity
      className="w-[200px] min-h-[140px] border border-border bg-card rounded-[14px] overflow-hidden flex-row"
      style={style}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={!onPress}
    >
      <View className="w-[60px] py-3 px-2 items-center justify-center bg-primary">
        {day !== null && (
          <>
            <Text className="text-[28px] font-bold text-white leading-[32px]">{day}</Text>
            {month && <Text className="text-[11px] font-semibold text-white uppercase mt-0.5">{month}</Text>}
            {year && <Text className="text-[10px] font-medium text-white opacity-90 mt-0.5">{year}</Text>}
          </>
        )}
      </View>
      <View className="flex-1 p-3 justify-center">
        <Text className="text-foreground text-[15px] font-semibold mb-1 leading-5" numberOfLines={2}>
          {name}
        </Text>
        {time && (
          <Text className="text-muted-foreground text-xs mb-1">
            {time}
          </Text>
        )}
        {location && (
          <Text className="text-muted-foreground text-[11px] mt-0.5" numberOfLines={1}>
            <Text>{'\uD83D\uDCCD'} </Text>
            <Text>{location}</Text>
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
};

export default PostAttachmentEvent;
