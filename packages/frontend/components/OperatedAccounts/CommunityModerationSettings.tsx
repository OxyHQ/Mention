import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { useTheme } from '@oxy.so/bloom/theme';

import { useRouter } from '@/lib/navigation/router';

/**
 * A COMMUNITY's moderation that is Mention's: who is banned from posting in
 * it. Its moderators are its Oxy account members, managed from the Members row
 * Oxy's `AccountSettings` already shows — so only the bans are linked here. A
 * channel has neither: it is published AS, not posted IN.
 */
export function CommunityModerationSettings({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  const openBans = useCallback(
    () => router.push(`/communities/${encodeURIComponent(accountId)}/bans`),
    [accountId, router],
  );

  return (
    <GroupedSection title={t('communities.settings.moderation')}>
      <GroupedSectionItem
        icon={<RiForbidLine width={20} height={20} fill={colors.textSecondary} />}
        title={t('communities.bans')}
        description={t('communities.settings.bansDescription')}
        onPress={openBans}
      />
    </GroupedSection>
  );
}
