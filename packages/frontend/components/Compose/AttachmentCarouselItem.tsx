import React, { ReactNode } from 'react';
import { View, TouchableOpacity, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { CloseIcon } from '@/assets/icons/close-icon';
import { useTheme } from '@/hooks/useTheme';

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
        <View style={[styles.reorderControls, { pointerEvents: 'box-none' }]}>
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'left')}
            disabled={!canMoveLeft}
            style={[styles.reorderButton, { backgroundColor: theme.colors.background }, !canMoveLeft && styles.reorderButtonDisabled]}
          >
            <BackArrowIcon size={14} color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'right')}
            disabled={!canMoveRight}
            style={[styles.reorderButton, { backgroundColor: theme.colors.background }, !canMoveRight && styles.reorderButtonDisabled]}
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
        style={[styles.removeButton, { backgroundColor: theme.colors.background }]}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <CloseIcon size={16} color={theme.colors.text} />
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  reorderControls: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 2,
  },
  reorderButton: {
    borderRadius: 999,
    padding: 6,
  },
  reorderButtonDisabled: {
    opacity: 0.4,
  },
  removeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
});

export default AttachmentCarouselItem;
