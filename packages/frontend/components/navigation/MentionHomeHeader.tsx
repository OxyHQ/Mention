import { Pressable } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useAskAgent } from '@alia.onl/sdk/ask';
import { AliaAvatarIcon } from '@alia.onl/sdk/avatar';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useAppShell } from '@oxy.so/bloom/app-shell/hooks';
import { IconButton } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiMenuLine } from '@oxy.so/bloom/icons/RiMenuLine';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';
import { useNavigateOrReselect } from '@/hooks/useNavigateOrReselect';

export function MentionHomeHeader() {
  const router = useRouter();
  const shell = useAppShell();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const navigateOrReselect = useNavigateOrReselect();
  // A sheet, not a page. Signed out, the press opens the Oxy sign-in dialog
  // (`MentionAskProvider`).
  const { ask } = useAskAgent();
  return (
    <PageHeader
      title={
        <Pressable
          onPress={() => navigateOrReselect('/')}
          accessibilityRole="button"
          accessibilityLabel="Mention"
          hitSlop={8}
        >
          <LogoIcon size={28} color={colors.text} />
        </Pressable>
      }
      titleAlign="center"
      presentation="floating"
      leading={
        <>
          {shell.drawerAvailable && (
            <IconButton
              size="md"
              leadingIcon={shell.drawerOpen ? RiCloseLine : RiMenuLine}
              accessibilityLabel={t('navigation.menu')}
              aria-expanded={shell.drawerOpen}
              onPress={shell.toggleDrawer}
              testID="sidebar-menu-button"
            />
          )}
          <ButtonGroup accessibilityLabel={t('Search')}>
            <ButtonGroupItem
              iconOnly
              leadingIcon={RiSearchLine}
              accessibilityLabel={t('Search')}
              onPress={() => router.push('/search')}
            />
          </ButtonGroup>
        </>
      }
      actions={
        <ButtonGroup accessibilityLabel={t('common.actions', { defaultValue: 'Page actions' })}>
          <ButtonGroupItem leadingIcon={AliaAvatarIcon} onPress={() => ask()}>
            {t('header.askAlia')}
          </ButtonGroupItem>
          <ButtonGroupItem
            iconOnly
            leadingIcon={RiNotification3Line}
            accessibilityLabel={t('Notifications')}
            onPress={() => router.push('/notifications')}
          />
        </ButtonGroup>
      }
    />
  );
}
