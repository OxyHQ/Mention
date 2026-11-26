import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useAskGemie } from '@gemies/sdk/ask';
import { GemieAvatarIcon } from '@gemies/sdk/avatar';
import { useAppShell } from '@oxy.so/bloom/app-shell/hooks';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { MenuIcon } from '@oxy.so/bloom/icons/MenuIcon';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';

import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTabPagerActions } from '@oxy.so/bloom/tab-pager';
import {
  Button as LButton,
  ButtonGroup,
  Embed,
  Header,
  Icon,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export function MentionHomeHeader() {
  const router = useRouter();
  const shell = useAppShell();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { selectDestination } = useTabPagerActions();
  // A sheet, not a page. Signed out, the press opens the Oxy sign-in dialog
  // (`MentionAskProvider`).
  const { ask } = useAskGemie();
  return toElement(
    Header(
      VStack(Embed(<LogoIcon size={28} color={colors.text} />))
        .onPress(() => selectDestination('(home)'))
        .role('button')
        .label('Mention')
        .hitSlop('md'),
    )
      .titleAlign('center')
      .presentation('floating')
      .toolbarLeading(
        shell.drawerAvailable
          ? LButton(Icon(shell.drawerOpen ? RiCloseLine : MenuIcon))
              .style('outline')
              .tint('neutral')
              .shape('circle')
              .label(t('navigation.menu'))
              .accessibilityState({ expanded: shell.drawerOpen })
              .onPress(shell.toggleDrawer)
              .testID('sidebar-menu-button')
          : null,
        ButtonGroup(
          LButton(Icon(RiSearchLine))
            .shape('circle')
            .label(t('common.search'))
            .onPress(() => router.push('/search')),
        ).label(t('common.search')),
      )
      .toolbar(
        ButtonGroup(
          LButton(Icon(GemieAvatarIcon), LText(t('header.askAlia'))).onPress(() => ask()),
          LButton(Icon(RiNotification3Line))
            .shape('circle')
            .label(t('notifications.title'))
            .onPress(() => router.push('/notifications')),
        ).label(t('common.actions', { defaultValue: 'Page actions' })),
      )
      // Bloom's PageHeader on every platform, as the JSX drew it (never iOS's system bar).
      .inPage(),
  );
}
