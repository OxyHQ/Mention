import { useMemo } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useDeckSettings } from '@/components/deck/deckSettings';
import { useAppShell } from '@oxy.so/bloom/app-shell';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import { ProfileButton } from '@oxy.so/services/ui/client';
import type { AccountDialogMenuItem } from '@oxy.so/services';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';

/**
 * The account control at the foot of the sidebar. It is the app's own content
 * in the drawer, not a row Bloom draws, so it closes the drawer itself before
 * going anywhere.
 */
function MentionSidebarFooter({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { selectDestination } = useTabPager();
  const { closeDrawer } = useAppShell();
  const menuItems = useMemo<AccountDialogMenuItem[]>(
    () => [
      {
        key: 'mention-settings',
        label: t('sidebar.accountMenu.settings'),
        icon: 'cog-outline',
        onPress: () => {
          closeDrawer();
          selectDestination('settings');
        },
      },
      {
        key: 'mention-memberships',
        label: t('memberships.title', 'Memberships'),
        icon: 'people-outline',
        onPress: () => {
          closeDrawer();
          router.navigate('/memberships');
        },
      },
      {
        key: 'mention-plus',
        label: t('sidebar.accountMenu.plus'),
        icon: 'crown-outline',
        onPress: () => {
          closeDrawer();
          router.navigate('/plus');
        },
      },
    ],
    [t, closeDrawer, selectDestination, router],
  );
  return (
    <ProfileButton
      expanded={!collapsed}
      menuItems={menuItems}
      onNavigateProfile={() => {
        closeDrawer();
        selectDestination('you');
      }}
      onBeforeAddAccount={closeDrawer}
    />
  );
}

// The chrome around the sidebar's rows. The rows themselves, their selection,
// badges and the compose action are Mention's destinations, which Bloom's app
// shell draws (`MentionNavigation`); the drawer closes itself on a choice made
// in its rows or on the logo.
export function useMentionSidebar(): SidebarProps {
  const { t } = useTranslation();
  const deckAvailable = useDeckAvailable();
  const deckEnabled = useDeckSettings((state) => state.deckEnabled);
  const { selectDestination } = useTabPager();
  const { colors } = useTheme();

  return {
    surface: 'plain',
    size: 'md',
    contentAlignment: 'center',
    showSearch: false,
    showThemeToggle: false,
    logo: {
      icon: <LogoIcon size={28} color={colors.text} />,
      accessibilityLabel: 'Mention',
      onPress: () => selectDestination('index'),
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
    footer: ({ collapsed }) => <MentionSidebarFooter collapsed={collapsed} />,
  };
}
