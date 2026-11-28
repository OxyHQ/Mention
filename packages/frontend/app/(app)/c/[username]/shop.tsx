// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useTranslation } from 'react-i18next';
import { Screen } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useProfileAccount } from '@/components/Profile/hooks/useProfileAccount';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';
import { LazyProfileShop } from '@/components/sharedRouteScreens';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';

export default function ChannelShopRoute() {
  const { t } = useTranslation();
  const { profileData, loading } = useProfileAccount(useRoutedProfileUsername());
  return (
    <Screen header={<PageHeader title={t('commerce.shop')} backLabel={t('common.back')} />}>
      {loading ? (
        <ListSkeleton />
      ) : profileData?.kind === 'channel' ? (
        <LazyProfileShop accountId={profileData.id} />
      ) : (
        <EmptyState title={t('commerce.shopUnavailable')} />
      )}
    </Screen>
  );
}
