import { tokens } from '@oxy.so/bloom/styles';
import type React from 'react';
import type { ReactNode } from 'react';
import { View, TouchableOpacity, type ViewStyle, type StyleProp } from 'react-native';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';

import { Icon, toElement } from '@oxy.so/bloom-language';

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
  const colorTokens = useColorTokens();
  const canMoveLeft = index > 0;
  const canMoveRight = index < total - 1;
  // A round control on the attachment (`rounded-full p-1.5 bg-background`).
  const control = [controlStyle, { backgroundColor: colorTokens.background }];

  return (
    <View style={wrapperStyle}>
      {total > 1 ? (
        // A React Native view with `box-none`: the language's
        // `allowsHitTesting('children')` is drawn on the web as `none` on the box
        // and `auto` on what is inside it, which is not what react-native-web
        // gives a disabled control here.
        <View style={MOVE_ROW}>
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'left')}
            disabled={!canMoveLeft}
            style={[control, !canMoveLeft && DISABLED]}
          >
            {toElement(Icon(RiArrowLeftLine).size('14').foreground('muted'))}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onMove(attachmentKey, 'right')}
            disabled={!canMoveRight}
            style={[control, !canMoveRight && DISABLED]}
          >
            {toElement(Icon(RiArrowRightSLine).size('14').foreground('muted'))}
          </TouchableOpacity>
        </View>
      ) : null}
      {children}
      <TouchableOpacity
        onPress={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        style={[control, REMOVE_PLACEMENT]}
        hitSlop={tokens.hitSlop.sm}
      >
        {toElement(Icon(RiCloseLine).size('sm').foreground('foreground'))}
      </TouchableOpacity>
    </View>
  );
};

/** Tailwind's 1.5 step, off Bloom's space scale. */
const SPACE_6 = 6;
const controlStyle = {
  padding: SPACE_6,
  borderRadius: Number.MAX_SAFE_INTEGER, // Tailwind's `rounded-full` as it drew
} satisfies ViewStyle;
/** The move controls along the bottom (`absolute left-2 right-2 bottom-2 flex-row justify-between items-center z-[2]`). */
const MOVE_ROW = {
  position: 'absolute',
  left: tokens.space.sm,
  right: tokens.space.sm,
  bottom: tokens.space.sm,
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  zIndex: 2,
  pointerEvents: 'box-none',
} satisfies ViewStyle;
/** A move that cannot happen (`opacity-40`). */
const DISABLED = { opacity: 0.4 } satisfies ViewStyle;
/** The remove control's corner (`absolute top-2 right-2`). */
const REMOVE_PLACEMENT = {
  position: 'absolute',
  top: tokens.space.sm,
  right: tokens.space.sm,
} satisfies ViewStyle;

export default AttachmentCarouselItem;
