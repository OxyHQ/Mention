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
