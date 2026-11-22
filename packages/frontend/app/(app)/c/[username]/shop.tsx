import { useTranslation } from 'react-i18next';
import { useProfileAccount } from '@/components/Profile/hooks/useProfileAccount';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';
import { LazyProfileShop } from '@/components/sharedRouteScreens';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { Embed, Header } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function ChannelShopRoute() {
  const { t } = useTranslation();
  const { profileData, loading } = useProfileAccount(useRoutedProfileUsername());
  return Embed(
    loading ? (
      <ListSkeleton />
    ) : profileData?.kind === 'channel' ? (
      <LazyProfileShop accountId={profileData.id} />
    ) : (
      <EmptyState title={t('commerce.shopUnavailable')} />
    ),
  ).header(Header(t('commerce.shop')).backLabel(t('common.back')).inPage());
});
