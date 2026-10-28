import { useTranslation } from 'react-i18next';
import { Screen } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useProfileAccount } from '@/components/Profile';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';
import { ProfileShop } from '@/components/Commerce/ProfileShop';
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
        <ProfileShop accountId={profileData.id} />
      ) : (
        <EmptyState title={t('commerce.shopUnavailable')} />
      )}
    </Screen>
  );
}
