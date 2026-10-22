import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { RiShieldUserLine } from '@oxy.so/bloom/icons/RiShieldUserLine';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';

import { useRouter } from '@/lib/navigation/router';

/**
 * A COMMUNITY's moderation: who moderates it and who is banned from posting in
 * it. Managing moderators is Oxy's shared account-members sheet (a community's
 * moderators are its account members), and bans are Mention's own list — both
 * are reached from here rather than re-implemented. A channel has neither: it is
 * published AS, not posted IN.
 */
export function CommunityModerationSettings({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const { showBottomSheet } = useAuth();

  const manageModerators = useCallback(
    () => showBottomSheet?.({ screen: 'AccountMembers', props: { accountId } }),
    [accountId, showBottomSheet],
  );
  const openBans = useCallback(
    () => router.push(`/communities/${encodeURIComponent(accountId)}/bans`),
    [accountId, router],
  );

  return (
    <SettingsListGroup title={t('communities.settings.moderation')}>
      <SettingsListItem
        icon={<RiShieldUserLine width={20} height={20} fill={colors.textSecondary} />}
        title={t('communities.manageModerators')}
        description={t('communities.settings.moderatorsDescription')}
        onPress={manageModerators}
      />
      <SettingsListItem
        icon={<RiForbidLine width={20} height={20} fill={colors.textSecondary} />}
        title={t('communities.bans')}
        description={t('communities.settings.bansDescription')}
        onPress={openBans}
      />
    </SettingsListGroup>
  );
}
