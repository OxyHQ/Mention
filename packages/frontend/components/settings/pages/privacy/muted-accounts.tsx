import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { SettingsSection } from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import { getNormalizedUserHandle, type User } from '@oxy.so/core';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { muteService } from '@/services/muteService';

interface MutedAccount {
  id: string;
  /** Absent when Oxy no longer resolves the account; it can still be unmuted. */
  user?: User;
}

/** The accounts this reader has muted, and the way back. */
export default function MutedAccountsScreen() {
  const { t } = useTranslation();
  const { isAuthenticated, user, canUsePrivateApi, oxyServices } = useAuth();
  const queryClient = useQueryClient();

  const queryKey = viewerQueryKeys.mutedAccounts(user?.id);
  const {
    data: muted = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<MutedAccount[]>({
    queryKey,
    queryFn: async () => {
      const mutes = await muteService.getMutedUsers();
      const ids = mutes.map((mute) => mute.mutedId);
      if (ids.length === 0) return [];
      const users = await oxyServices.users.getMany(ids);
      const byId = new Map(users.map((entry) => [entry.id, entry]));
      return ids.map((id) => ({ id, user: byId.get(id) }));
    },
    enabled: canUsePrivateApi,
    // A mute made from a post or a profile must show the next time this opens.
    refetchOnMount: 'always',
  });

  const unmute = useMutation<void, Error, string>({
    mutationFn: async (id) => {
      if (!(await muteService.unmuteUser(id, user?.id))) throw new Error('Unmute failed');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      toast(t('settings.privacy.mutedAccounts.unmuted'), { type: 'success' });
    },
    onError: () => {
      toast(t('settings.privacy.mutedAccounts.unmuteFailed'), { type: 'error' });
    },
  });

  if (!isAuthenticated) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t('settings.privacy.mutedAccounts.signInRequired')}
          description={t('settings.privacy.mutedAccounts.description')}
        />
      </View>
    );
  }

  const loadFailed = t('settings.privacy.mutedAccounts.loadFailed');

  return (
    <View className="gap-4">
      <Admonition type="info">{t('settings.privacy.mutedAccounts.description')}</Admonition>

      <SettingsSection label={t('settings.privacy.mutedAccounts.title')}>
        <GroupedSection>
          {isLoading ? (
            <ListSkeleton />
          ) : isError ? (
            <View className="py-4">
              <EmptyState
                title={loadFailed}
                error={{
                  title: loadFailed,
                  message: t('common.tryAgain', { defaultValue: 'Try again' }),
                  onRetry: async () => {
                    await refetch();
                  },
                }}
              />
            </View>
          ) : muted.length === 0 ? (
            <View className="py-4">
              <EmptyState
                title={t('settings.privacy.mutedAccounts.empty')}
                sticker="blockedAccounts"
              />
            </View>
          ) : (
            muted.map((entry) => {
              const handle = entry.user ? getNormalizedUserHandle(entry.user) : undefined;
              const name =
                entry.user?.name?.displayName ?? t('settings.privacy.mutedAccounts.unknown');
              return (
                <GroupedSectionItem
                  wrapControl
                  key={entry.id}
                  title={name}
                  description={handle ? `@${handle}` : undefined}
                  rightElement={
                    <Button
                      size="sm"
                      appearance="subtle"
                      tone="neutral"
                      disabled={unmute.isPending}
                      onPress={() => unmute.mutate(entry.id)}
                      accessibilityLabel={`${t('settings.privacy.mutedAccounts.unmute')} ${name}`}
                    >
                      {t('settings.privacy.mutedAccounts.unmute')}
                    </Button>
                  }
                />
              );
            })
          )}
        </GroupedSection>
      </SettingsSection>
    </View>
  );
}
