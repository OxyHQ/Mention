import React, { ReactNode } from 'react';
import { View, TouchableOpacity, ViewStyle, StyleProp } from 'react-native';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { CloseIcon } from '@/assets/icons/close-icon';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

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
  const theme = useTheme();
  const canMoveLeft = index > 0;
  const canMoveRight = index < total - 1;

  return (
    <View style={wrapperStyle}>
      {total > 1 ? (
        <View className="absolute left-2 right-2 bottom-2 flex-row justify-between items-center z-[2]" style={{ pointerEvents: 'box-none' }}>
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'left')}
            disabled={!canMoveLeft}
            className={cn('rounded-full p-1.5 bg-background', !canMoveLeft && 'opacity-40')}
          >
            <BackArrowIcon size={14} color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'right')}
            disabled={!canMoveRight}
            className={cn('rounded-full p-1.5 bg-background', !canMoveRight && 'opacity-40')}
          >
            <ChevronRightIcon size={14} color={!canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary} />
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
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <CloseIcon size={16} color={theme.colors.text} />
      </TouchableOpacity>
    </View>
  );
};

export default AttachmentCarouselItem;
