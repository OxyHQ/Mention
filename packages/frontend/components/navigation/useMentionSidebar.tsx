import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useDeckSettings } from '@/components/deck/deckSettings';
import { useAccountEntry } from '@/components/auth/useAccountEntry';
import { useAppShell } from '@oxy.so/bloom/app-shell';
import { Button } from '@oxy.so/bloom/button';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import { ProfileButton, useAuth } from '@oxy.so/services/ui/client';
import type { AccountDialogMenuItem } from '@oxy.so/services';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiLoginBoxLine } from '@oxy.so/bloom/icons/RiLoginBoxLine';
import { RiUserAddFill } from '@oxy.so/bloom/icons/RiUserAddFill';
import { MentionNavigationLogo } from './MentionNavigationLogo';

/**
 * Signed-out account actions. ProfileButton only offers Sign in; Create account
 * is the primary action and Sign in stays available. The drawer closes first,
 * the same way the signed-in footer does, so the dialog is not behind it.
 */
function SignedOutSidebarAccount({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { closeDrawer } = useAppShell();
  const { createAccount, signInAccount } = useAccountEntry();
  const openSignup = useCallback(() => {
    closeDrawer();
    createAccount();
  }, [closeDrawer, createAccount]);
  const openSignIn = useCallback(() => {
    closeDrawer();
    signInAccount();
  }, [closeDrawer, signInAccount]);

  if (collapsed) {
    return (
      <View style={{ gap: 8, alignItems: 'center' }}>
        <Button
          testID="sidebar-create-account"
          appearance="solid"
          tone="accent"
          iconOnly
          size="sm"
          leadingIcon={RiUserAddFill}
          accessibilityLabel={t('auth.banner.createAccount')}
          onPress={openSignup}
        />
        <Button
          testID="sidebar-sign-in"
          appearance="plain"
          tone="neutral"
          iconOnly
          size="sm"
          leadingIcon={RiLoginBoxLine}
          accessibilityLabel={t('auth.banner.signIn')}
          onPress={openSignIn}
        />
      </View>
    );
  }

  return (
    <View style={{ gap: 8, width: '100%' }}>
      <Button
        testID="sidebar-create-account"
        appearance="solid"
        tone="accent"
        fullWidth
        onPress={openSignup}
      >
        {t('auth.banner.createAccount')}
      </Button>
      <Button
        testID="sidebar-sign-in"
        appearance="plain"
        tone="neutral"
        fullWidth
        onPress={openSignIn}
      >
        {t('auth.banner.signIn')}
      </Button>
    </View>
  );
}

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
  const { isAuthenticated, isAuthResolved } = useAuth();
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
  if (isAuthResolved && !isAuthenticated) {
    return <SignedOutSidebarAccount collapsed={collapsed} />;
  }
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

  return {
    surface: 'plain',
    size: 'md',
    contentAlignment: 'center',
    showSearch: false,
    showThemeToggle: false,
    logo: {
      icon: <MentionNavigationLogo />,
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
