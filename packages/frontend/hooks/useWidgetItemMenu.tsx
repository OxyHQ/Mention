import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { HideIcon } from '@/assets/icons/hide-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import type { ActionMenuGroups } from '@/components/common/ActionMenuTrigger';

const ICON_SIZE = 20;

interface WidgetItemMenuConfig {
  /** Hide the item from its widget. */
  onNotInterested: () => void;
  /** Share the item's deep link. */
  onShare: () => void;
}

/**
 * The groups of the shared ⋯ menu on the Trends and Live Rooms items, so both
 * are identical: "Not interested" (hide) and "Share". Rendered by
 * `ActionMenuTrigger`, Bloom's DropdownMenu.
 */
export function useWidgetItemMenu() {
  const { t } = useTranslation();
  const theme = useTheme();

  return useCallback(
    ({ onNotInterested, onShare }: WidgetItemMenuConfig): ActionMenuGroups => [
      [
        {
          icon: <HideIcon size={ICON_SIZE} color={theme.colors.textSecondary} />,
          label: t('widgetMenu.notInterested'),
          onPress: onNotInterested,
        },
        {
          icon: <ShareIcon size={ICON_SIZE} color={theme.colors.textSecondary} />,
          label: t('widgetMenu.share'),
          onPress: onShare,
        },
      ],
    ],
    [t, theme.colors.textSecondary],
  );
}
