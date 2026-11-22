import { tokens } from '@oxy.so/bloom/styles';
import { TouchableOpacity, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiUpload2Line } from '@oxy.so/bloom/icons/RiUpload2Line';

import { Icon, toElement } from '@oxy.so/bloom-language';

// The trigger stays React Native's TouchableOpacity, the DropdownMenu trigger's own
// child (asChild); this draws its classes, `p-1` (it is a pointer on the web already).
const triggerStyle: ViewStyle = { padding: 4 };

const ICON_SIZE = 20;

/** What the ⋯ menu of a widget item does; the item owns both. */
export interface WidgetItemMenuActions {
  /** Hide the item from its widget. */
  onNotInterested: () => void;
  /** Share the item's deep link. */
  onShare: () => void;
}

interface WidgetItemMenuProps extends WidgetItemMenuActions {
  /** What the menu acts on (the trend text, the room title). */
  label: string;
}

/**
 * The ⋯ menu on the Trends and Live Rooms items, shared so the two are
 * identical: "Not interested" and "Share".
 */
export function WidgetItemMenu({ label, onNotInterested, onShare }: WidgetItemMenuProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={label}>
        <TouchableOpacity
          style={triggerStyle}
          hitSlop={tokens.hitSlop.lg}
          accessibilityLabel="More options"
          accessibilityRole="button"
        >
          {toElement(Icon(RiMoreFill).size('sm').foreground('muted'))}
        </TouchableOpacity>
      </DropdownMenuTrigger>
      <DropdownMenuContent label={label}>
        <DropdownMenuItem
          leading={
            <RiEyeOffLine width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.textSecondary} />
          }
          onPress={onNotInterested}
        >
          {t('widgetMenu.notInterested')}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={
            <RiUpload2Line width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.textSecondary} />
          }
          onPress={onShare}
        >
          {t('widgetMenu.share')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
