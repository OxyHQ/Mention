import { useCallback, useMemo } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useDeckSettings } from '@/components/deck/deckSettings';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import { ProfileButton } from '@oxy.so/services/ui/client';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountDialogMenuItem } from '@oxy.so/services';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';
import { useDrawer } from '@/context/DrawerContext';

// The chrome around the sidebar's rows. The rows themselves, their selection,
// badges and the compose action are Mention's destinations, which Bloom's app
// shell draws (`MentionNavigation`); the drawer closes itself on a choice made
// in its rows. The logo and the account footer are not rows, so they close it.
export function useMentionSidebar(): SidebarProps {
  const { t } = useTranslation();
  const deckAvailable = useDeckAvailable();
  const deckEnabled = useDeckSettings((state) => state.deckEnabled);
  const router = useRouter();
  const { signIn } = useAuth();
  const { selectDestination } = useTabPager();
  const { close } = useDrawer();
  const { colors } = useTheme();
  const go = useCallback(
    (destination: string) => {
      close();
      selectDestination(destination);
    },
    [close, selectDestination],
  );
  const handleAddAccount = useCallback(() => {
    close();
    signIn().catch(() => {});
  }, [close, signIn]);
  const accountMenuItems = useMemo<AccountDialogMenuItem[]>(
    () => [
      {
        key: 'mention-settings',
        label: t('sidebar.accountMenu.settings'),
        icon: 'cog-outline',
        onPress: () => go('settings'),
      },
      {
        key: 'mention-plus',
        label: t('sidebar.accountMenu.plus'),
        icon: 'crown-outline',
        onPress: () => {
          close();
          router.navigate('/plus');
        },
      },
    ],
    [t, go, close, router],
  );

  return {
    surface: 'plain',
    size: 'md',
    contentAlignment: 'center',
    showSearch: false,
    showThemeToggle: false,
    logo: {
      icon: <LogoIcon size={28} color={colors.text} />,
      accessibilityLabel: 'Mention',
      onPress: () => go('index'),
    },
    modes: deckAvailable
      ? [
          {
            key: 'standard',
            label: t('deck.mode.standard', 'Standard'),
            icon: RiHome5Line,
          },
          { key: 'deck', label: 'Deck', icon: RiDashboardLine },
        ]
      : undefined,
    mode: deckEnabled ? 'deck' : 'standard',
    modesPresentation: 'toggle',
    modesLabel: t('deck.mode.label', 'Deck mode'),
    onModeChange: (mode) => useDeckSettings.getState().setDeckEnabled(mode === 'deck'),
    footer: ({ collapsed }) => (
      <ProfileButton
        expanded={!collapsed}
        menuItems={accountMenuItems}
        onNavigateProfile={() => go('you')}
        onAddAccount={handleAddAccount}
      />
    ),
  };
}
