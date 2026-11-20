/**
 * Mention's bottom bar in the Bloom language: the tab pager's pages as tabs and
 * the compose FAB as its action. Bloom draws the bar (with the lens on Android);
 * the FAB sits on the platform's glass.
 */
import type { ReactElement } from 'react';
import { BottomBar, FAB, Icon, Tab, toElement, view } from '@oxy.so/bloom-language';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { useTabPager } from '@oxy.so/bloom/tab-pager';

interface LanguageBottomBarProps {
  composeLabel: string;
  onCompose: () => void;
}

const LanguageBottomBar = view(function LanguageBottomBar(props: LanguageBottomBarProps) {
  const pager = useTabPager();
  const pages = pager.pages.filter((page) => page.bar && page.icon);
  // A route that is not one of the bar's pages selects no tab.
  const selection = pages.some((page) => page.name === pager.activePage) ? pager.activePage : null;
  return BottomBar(
    pages.map((page) => {
      const tab = Tab(page.label ?? '', page.icon as NonNullable<typeof page.icon>)
        .id(page.name)
        .badge(page.badge);
      return page.activeIcon ? tab.activeIcon(page.activeIcon) : tab;
    }),
  )
    .selection(selection ?? '')
    .onSelect(pager.selectDestination)
    .progress(pager.progress)
    .hide(pager.chromeProgress)
    .action(FAB(Icon(RiQuillPenLine)).label(props.composeLabel).onPress(props.onCompose));
});

/** The bar as the shell's `bottomBar` element. */
export function languageBottomBar(props: LanguageBottomBarProps): ReactElement {
  return toElement(LanguageBottomBar(props));
}
