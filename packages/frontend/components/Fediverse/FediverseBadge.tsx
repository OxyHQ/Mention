import React, { useCallback, useContext } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PointerEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { FediverseInfoSheet } from './FediverseInfoSheet';

interface FediverseBadgeProps {
  /** Icon size in px. Defaults to 15 (inline-with-text size). */
  size?: number;
  /** Icon color class. Defaults to a muted foreground tone when no `color` is set. */
  className?: string;
  /** Explicit fill color; overrides `className`. Used where callers pass a resolved theme color. */
  color?: string;
  /** Layout class for the tappable wrapper (e.g. `self-center ml-1` at a call site). */
  containerClassName?: string;
  /** Style for the tappable wrapper (e.g. the baseline-nudge transform in UserName). */
  style?: StyleProp<ViewStyle>;
}

/**
 * Tappable fediverse icon that opens the educational `FediverseInfoSheet` in
 * Mention's shared bottom sheet. Rendered wherever a fediverse marker appears —
 * federated profile cards and headers, post headers, search results, and the
 * web profile hover card — so the marker is consistently explained on tap.
 */
export function FediverseBadge({ size = 15, className, color, containerClassName, style }: FediverseBadgeProps) {
  const { t } = useTranslation();
  const bottomSheet = useContext(BottomSheetContext);

  const openSheet = useCallback(
    (event?: GestureResponderEvent) => {
      // The badge is nested inside a pressable row/card (ProfileCard, post
      // header, search card); stop the click from bubbling to click-based
      // parents so tapping it opens the sheet without also triggering the
      // parent's navigation.
      event?.stopPropagation?.();
      bottomSheet.setBottomSheetContent(
        <FediverseInfoSheet onClose={() => bottomSheet.openBottomSheet(false)} />,
      );
      bottomSheet.openBottomSheet(true);
    },
    [bottomSheet],
  );

  // The web profile hover card navigates on a raw `onPointerUp` on an ancestor
  // View — a channel `onPress`/click stopPropagation cannot reach. Stopping the
  // pointer event here keeps the parent from navigating. It does not disturb the
  // badge's own press: react-native-web's press responder is driven by
  // mouseup/touchend, not pointerup, so the sheet still opens.
  const stopPointer = useCallback((event: PointerEvent) => {
    event.stopPropagation();
  }, []);

  const iconClassName = className ?? (color ? undefined : 'text-muted-foreground');

  return (
    <Pressable
      onPress={openSheet}
      onPointerUp={stopPointer}
      accessibilityRole="button"
      accessibilityLabel={t('fediverse.badge.a11yLabel')}
      hitSlop={8}
      className={containerClassName}
      style={style}
    >
      <FediverseIcon size={size} color={color} className={iconClassName} />
    </Pressable>
  );
}
