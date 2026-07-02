import React, { useCallback, useContext } from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { FediverseInfoSheet } from './FediverseInfoSheet';

interface FediverseBadgeProps {
  /** Icon size in px. Defaults to 15 (inline-with-text size). */
  size?: number;
  /** Icon color class. Defaults to a muted foreground tone. */
  className?: string;
}

/**
 * Tappable fediverse icon that opens the educational `FediverseInfoSheet` in
 * Mention's shared bottom sheet. Rendered next to the handle on federated
 * profile cards and on the viewer's own profile when fediverse sharing is on.
 */
export function FediverseBadge({ size = 15, className = 'text-muted-foreground' }: FediverseBadgeProps) {
  const { t } = useTranslation();
  const bottomSheet = useContext(BottomSheetContext);

  const openSheet = useCallback(
    (event: GestureResponderEvent) => {
      // The badge is often nested inside a pressable row/card (e.g. ProfileCard);
      // stop propagation so tapping it opens the sheet without also triggering
      // the parent's navigation.
      event?.stopPropagation?.();
      bottomSheet.setBottomSheetContent(
        <FediverseInfoSheet onClose={() => bottomSheet.openBottomSheet(false)} />,
      );
      bottomSheet.openBottomSheet(true);
    },
    [bottomSheet],
  );

  return (
    <Pressable
      onPress={openSheet}
      accessibilityRole="button"
      accessibilityLabel={t('fediverse.badge.a11yLabel')}
      hitSlop={8}
    >
      <FediverseIcon size={size} className={className} />
    </Pressable>
  );
}
