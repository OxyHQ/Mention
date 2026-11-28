import { tokens } from '@oxy.so/bloom/styles';
import { TouchableOpacity } from 'react-native';
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
          className="p-1 web:cursor-pointer"
          hitSlop={tokens.hitSlop.lg}
          accessibilityLabel="More options"
          accessibilityRole="button"
        >
          <RiMoreFill size="sm" fill={theme.colors.textSecondary} />
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
