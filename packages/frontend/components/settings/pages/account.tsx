import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useOxyIdentityRows } from '@/components/settings/useOxyIdentityRows';
import { useMentionSettings } from '@/context/MentionSettingsContext';
import { useProfileData } from '@/hooks/useProfileData';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { confirmDialog } from '@/utils/alerts';
import { SettingsProfilePage } from '@oxy.so/bloom/settings-modal';
import { useBloomTheme } from '@oxy.so/bloom/theme';
import { createLogger } from '@oxy.so/core/logger';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Button as LButton, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';

const logger = createLogger('SettingsAccount');
export default function AccountSettingsContent() {
  const { t } = useTranslation();
  const { user, isAuthenticated, isAuthResolved, showBottomSheet, signIn, signOut } = useAuth();
  const {
    data: profile,
    error: isError,
    loading,
    refresh: refetch,
  } = useProfileData(user?.username);
  const { resetTheme } = useBloomTheme();
  const resetAppearance = useAppearanceStore((state) => state.reset);
  const { afterClose, navigate } = useMentionSettings();
  const identityRows = useOxyIdentityRows();
  const logout = async () => {
    if (
      !(await confirmDialog({
        title: t('settings.signOut'),
        message: t('settings.signOutMessage'),
        okText: t('settings.signOut'),
        cancelText: t('common.cancel'),
        destructive: true,
      }))
    )
      return;
    try {
      await signOut();
    } catch (error) {
      logger.warn('Sign-out failed; clearing local appearance', { error });
    }
    resetAppearance();
    resetTheme();
    navigate('/');
  };
  if (isAuthenticated && (isError || (!profile && !loading)))
    return (
      <SettingsProfilePage
        sections={[
          {
            key: 'error',
            rows: [
              {
                key: 'retry',
                label: t('settings.account.loadFailed', {
                  defaultValue: 'Could not load your account',
                }),
                control: toElement(
                  LButton(LText(t('common.retry', { defaultValue: 'Try again' })))
                    .style('subtle')
                    .tint('neutral')
                    .onPress(() => {
                      void refetch();
                    }),
                ),
              },
            ],
          },
        ]}
      />
    );
  if (!isAuthResolved || (isAuthenticated && !profile)) return <SettingsSkeleton />;
  if (!isAuthenticated)
    return toElement(
      VStack(
        LText(
          t('settings.account.signedOutSubtitle', {
            defaultValue:
              'Sign in to access your privacy, notifications, feed, and personalization settings.',
          }),
        ),
        LButton(
          LText(
            t('settings.account.signedOutTitle', {
              defaultValue: 'Sign in to Mention',
            }),
          ),
        ).onPress(() =>
          afterClose(() => {
            void signIn();
          }),
        ),
      ).spacing('lg'),
    );
  return (
    <SettingsProfilePage
      sections={[
        {
          key: 'identity',
          rows: [...identityRows],
        },
        {
          key: 'account',
          rows: [
            {
              key: 'manage',
              label: t('settings.account.manageAccount', {
                defaultValue: 'Manage account',
              }),
              description: t('settings.account.oxyDescription', {
                defaultValue: 'Manage your shared Oxy identity, profile and security.',
              }),
              control: toElement(
                LButton(LText(t('common.manage', { defaultValue: 'Manage' })))
                  .size('sm')
                  .style('subtle')
                  .tint('neutral')
                  .onPress(() => showBottomSheet?.('ManageAccount')),
              ),
            },
            {
              key: 'signout',
              label: t('settings.signOut'),
              control: toElement(
                LButton(LText(t('settings.signOut')))
                  .size('sm')
                  .style('subtle')
                  .tint('danger')
                  .onPress(logout),
              ),
            },
          ],
        },
      ]}
    />
  );
}
