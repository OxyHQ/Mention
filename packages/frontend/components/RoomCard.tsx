import { memo } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { LIVE_INDICATOR_COLOR, LIVE_INDICATOR_FOREGROUND_COLOR } from '@/styles/colors';

import { Embed, HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

interface RoomCardData {
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
  className?: string;
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
  className,
}: RoomCardProps) {
  const theme = useTheme();
  const live = room.status === 'live';
  const listeners = room.participants?.length ?? 0;
  const compact = variant === 'compact';
  const disc = compact ? 34 : 40;

  return (
    <Card
      radius="radius-16"
      onPress={onPress}
      accessibilityLabel={`${room.title}, ${room.status}`}
      className={className}
      style={[{ padding: compact ? 12 : 16 }, style]}
      appearance="outline"
    >
      {toElement(
        HStack(
          /* A live room's disc is the fixed live signal; any other state sits on
                  the quiet secondary surface. Both halves of the pair are overridden
                  together, as `IconCircle` asks. */ Embed(
            <IconCircle
              icon={live ? RiBroadcastLine : RiCalendarLine}
              size={compact ? 'sm' : 'md'}
              style={{
                width: disc,
                height: disc,
                backgroundColor: live ? LIVE_INDICATOR_COLOR : theme.colors.backgroundSecondary,
              }}
              iconStyle={{ color: live ? LIVE_INDICATOR_FOREGROUND_COLOR : theme.colors.text }}
            />,
          ),
          VStack(
            RawText(room.title).weight('semibold').foreground('foreground').lines(1),
            RawText(
              live ? `${listeners} listening` : room.status,
              room.topic ? ` · ${room.topic}` : '',
            )
              .margin('top', '2xs')
              .font('xs')
              .leading('16px')
              .foreground('muted')
              .lines(1),
          ).flex('1'),
          onPress ? Icon(RiArrowRightSLine).size('18').foreground('muted') : null,
        )
          .align('center')
          .spacing('md'),
      )}
    </Card>
  );
});

export default RoomCard;
