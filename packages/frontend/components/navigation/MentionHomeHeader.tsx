import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useAskGemie } from '@gemies/sdk/ask';
import { GemieAvatarIcon } from '@gemies/sdk/avatar';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useAppShell } from '@oxy.so/bloom/app-shell/hooks';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { MenuIcon } from '@oxy.so/bloom/icons/MenuIcon';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';

import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import {
  Button as LButton,
  Icon,
  toElement,
  Embed,
  VStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

export function MentionHomeHeader() {
  const router = useRouter();
  const shell = useAppShell();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { selectDestination } = useTabPager();
  // A sheet, not a page. Signed out, the press opens the Oxy sign-in dialog
  // (`MentionAskProvider`).
  const { ask } = useAskGemie();
  return (
    <PageHeader
      title={LtoElement(
        VStack(Embed(<LogoIcon size={28} color={colors.text} />))
          .onPress(() => selectDestination('(home)'))
          .role('button')
          .label('Mention')
          .hitSlop('md'),
      )}
      titleAlign="center"
      presentation="floating"
      leading={
        <>
          {shell.drawerAvailable && (
            <Button
              appearance="outline"
              tone="neutral"
              iconOnly
              size="md"
              leadingIcon={shell.drawerOpen ? RiCloseLine : MenuIcon}
              accessibilityLabel={t('navigation.menu')}
              aria-expanded={shell.drawerOpen}
              onPress={shell.toggleDrawer}
              testID="sidebar-menu-button"
            />
          )}
          <Button.Group accessibilityLabel={t('common.search')}>
            {toElement(
              LButton(Icon(RiSearchLine))
                .shape('circle')
                .label(t('common.search'))
                .onPress(() => router.push('/search')),
            )}
          </Button.Group>
        </>
      }
      actions={
        <Button.Group accessibilityLabel={t('common.actions', { defaultValue: 'Page actions' })}>
          <Button leadingIcon={GemieAvatarIcon} onPress={() => ask()}>
            {t('header.askAlia')}
          </Button>
          {toElement(
            LButton(Icon(RiNotification3Line))
              .shape('circle')
              .label(t('notifications.title'))
              .onPress(() => router.push('/notifications')),
          )}
        </Button.Group>
      }
    />
  );
}
