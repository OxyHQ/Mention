import type React from 'react';
import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { tokens } from '@oxy.so/bloom/styles';

import {
  Embed,
  Icon,
  type IconComponent,
  type ViewModifier,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface AttachmentCarouselItemProps {
  attachmentKey: string;
  index: number;
  total: number;
  onMove: (key: string, direction: 'left' | 'right') => void;
  onRemove: () => void;
  /** The card's own frame, as the caller places it. */
  look?: ViewModifier;
  children: ReactNode;
}

/** A round control on the attachment (`rounded-full p-1.5 bg-background`), faded while it cannot act (`opacity-40`). */
const control = (icon: IconComponent, enabled: boolean, onPress: () => void) =>
  VStack(Icon(icon).size('14').foreground('muted'))
    .padding('6')
    .background('background')
    .corner('infinite')
    .when(!enabled, (v) => v.opacity('40'))
    .onPress(onPress)
    .disabled(!enabled)
    .pressFade();

const AttachmentCarouselItem: React.FC<AttachmentCarouselItemProps> = ({
  attachmentKey,
  index,
  total,
  onMove,
  onRemove,
  look,
  children,
}) => {
  const canMoveLeft = index > 0;
  const canMoveRight = index < total - 1;

  return toElement(
    VStack(
      total > 1
        ? Embed(
            // A React Native view with `box-none`: the language's
            // `allowsHitTesting('children')` is drawn on the web as `none` on the box
            // and `auto` on what is inside it, which is not what react-native-web
            // gives a disabled control here.
            <View style={MOVE_ROW}>
              {toElement(
                control(RiArrowLeftLine, canMoveLeft, () => onMove(attachmentKey, 'left')),
              )}
              {toElement(
                control(RiArrowRightSLine, canMoveRight, () => onMove(attachmentKey, 'right')),
              )}
            </View>,
          )
        : null,
      Embed(children),
      VStack(Icon(RiCloseLine).size('sm').foreground('foreground'))
        .padding('6')
        .background('background')
        .corner('infinite')
        .position({ top: 'sm', right: 'sm' })
        .onPress((e) => {
          e.stopPropagation();
          onRemove();
        })
        .hitSlop('sm')
        .pressFade(),
    ).modifier(look),
  );
};

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

export default AttachmentCarouselItem;
