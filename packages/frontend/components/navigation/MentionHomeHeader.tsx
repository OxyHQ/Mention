import { Pressable } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useAskGemie } from '@gemies/sdk/ask';
import { GemieAvatarIcon } from '@gemies/sdk/avatar';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useAppShell } from '@oxy.so/bloom/app-shell/hooks';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiMenuLine } from '@oxy.so/bloom/icons/RiMenuLine';

import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { MentionNavigationLogo } from './MentionNavigationLogo';
import { useTabPager } from '@oxy.so/bloom/tab-pager';

export function MentionHomeHeader() {
  const router = useRouter();
  const shell = useAppShell();
  const { t } = useTranslation();
  const { selectDestination } = useTabPager();
  // A sheet, not a page. Signed out, the press opens the Oxy sign-in dialog
  // (`MentionAskProvider`).
  const { ask } = useAskGemie();
  return (
    <PageHeader
      title={
        <Pressable
          onPress={() => selectDestination('index')}
          accessibilityRole="button"
          accessibilityLabel="Mention"
          hitSlop={8}
        >
          <MentionNavigationLogo />
        </Pressable>
      }
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
              leadingIcon={shell.drawerOpen ? RiCloseLine : RiMenuLine}
              accessibilityLabel={t('navigation.menu')}
              aria-expanded={shell.drawerOpen}
              onPress={shell.toggleDrawer}
              testID="sidebar-menu-button"
            />
          )}
          <Button.Group accessibilityLabel={t('common.search')}>
            <Button
              iconOnly
              leadingIcon={RiSearchLine}
              accessibilityLabel={t('common.search')}
              onPress={() => router.push('/search')}
            />
          </Button.Group>
        </>
      }
      actions={
        <Button.Group accessibilityLabel={t('common.actions', { defaultValue: 'Page actions' })}>
          <Button leadingIcon={GemieAvatarIcon} onPress={() => ask()}>
            {t('header.askAlia')}
          </Button>
          <Button
            iconOnly
            leadingIcon={RiNotification3Line}
            accessibilityLabel={t('notifications.title')}
            onPress={() => router.push('/notifications')}
          />
        </Button.Group>
      }
    />
  );
}
