import { useTranslation } from 'react-i18next';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiUpload2Line } from '@oxy.so/bloom/icons/RiUpload2Line';

import { Icon, Item, Menu, VStack, toElement } from '@oxy.so/bloom-language';

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

  // Bloom's DropdownMenu on every platform, as the app drew it (not the platform's menu);
  // its rows' glyphs are the menu's own 20pt quiet ink.
  return toElement(
    Menu(
      VStack(Icon(RiMoreFill).size('sm').foreground('muted'))
        .padding('all', 'xs')
        .hitSlop('lg')
        .label('More options')
        .role('button')
        .pressFade(),
      Item(t('widgetMenu.notInterested')).icon(RiEyeOffLine).onPress(onNotInterested),
      Item(t('widgetMenu.share')).icon(RiUpload2Line).onPress(onShare),
    )
      .menuStyle('dropdown')
      .label(label),
  );
}
