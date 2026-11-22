import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useRouter } from '@/lib/navigation/router';

import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  Icon,
  toElement,
} from '@oxy.so/bloom-language';

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

  return toElement(
    LGroupedSection(
      LGroupedSectionItem(t('communities.bans'))
        .leadingView(Icon(RiForbidLine).size('md').foreground('muted'))
        .description(t('communities.settings.bansDescription'))
        .onPress(openBans),
    ).title(t('communities.settings.moderation')),
  );
}
