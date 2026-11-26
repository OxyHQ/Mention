import type React from 'react';
import type { ReactNode } from 'react';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';

import {
  Embed,
  HStack,
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
        ? // The move controls along the bottom. The app's inline `box-none` is a
          // native hit testing: react-native-web writes it as a CSS value the
          // browser drops, so on the web the row's box takes touches as any view.
          HStack(
            control(RiArrowLeftLine, canMoveLeft, () => onMove(attachmentKey, 'left')),
            control(RiArrowRightSLine, canMoveRight, () => onMove(attachmentKey, 'right')),
          )
            .justify('between')
            .align('center')
            .zIndex('2')
            .position({ left: 'sm', right: 'sm', bottom: 'sm' })
            .when('native', (v) => v.allowsHitTesting('children'))
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

export default AttachmentCarouselItem;
