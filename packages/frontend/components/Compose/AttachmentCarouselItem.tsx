import type React from 'react';
import type { ReactNode } from 'react';
import { View, TouchableOpacity, type ViewStyle, type StyleProp } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { cn } from '@/lib/utils';
import { HIT_SLOP_SM } from '@/styles/hitSlop';

interface AttachmentCarouselItemProps {
  attachmentKey: string;
  index: number;
  total: number;
  onMove: (key: string, direction: 'left' | 'right') => void;
  onRemove: () => void;
  wrapperStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}

const AttachmentCarouselItem: React.FC<AttachmentCarouselItemProps> = ({
  attachmentKey,
  index,
  total,
  onMove,
  onRemove,
  wrapperStyle,
  children,
}) => {
  const { colors } = useTheme();
  const canMoveLeft = index > 0;
  const canMoveRight = index < total - 1;

  return (
    <View style={wrapperStyle}>
      {total > 1 ? (
        <View
          className="absolute left-2 right-2 bottom-2 flex-row justify-between items-center z-[2]"
          style={{ pointerEvents: 'box-none' }}
        >
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'left')}
            disabled={!canMoveLeft}
            className={cn('rounded-full p-1.5 bg-background', !canMoveLeft && 'opacity-40')}
          >
            <RiArrowLeftLine width={14} height={14} fill={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'right')}
            disabled={!canMoveRight}
            className={cn('rounded-full p-1.5 bg-background', !canMoveRight && 'opacity-40')}
          >
            <RiArrowRightSLine width={14} height={14} fill={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ) : null}
      {children}
      <TouchableOpacity
        onPress={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute top-2 right-2 rounded-full p-1.5 bg-background"
        hitSlop={HIT_SLOP_SM}
      >
        <RiCloseLine width={16} height={16} fill={colors.text} />
      </TouchableOpacity>
    </View>
  );
};

export default AttachmentCarouselItem;
