import { PageHeader } from '@oxy.so/bloom/page-header';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useTranslation } from 'react-i18next';
import { usePathname, useRouter } from '@/lib/navigation/router';
import { useProfileData } from '@/hooks/useProfileData';
import { useRoutedProfileUsername } from './hooks/useRoutedProfileUsername';

export function ConnectionsHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const username = useRoutedProfileUsername().replace(/^@/, '');
  const { data } = useProfileData(username);
  const { t } = useTranslation();
  const handle =
    getNormalizedUserHandle({
      username: data?.username || username,
      instance: data?.instance,
      isFederated: data?.isFederated,
    }) || username;
  const active = pathname?.endsWith('/following')
    ? 'following'
    : pathname?.endsWith('/who-may-know')
      ? 'who-may-know'
      : pathname?.endsWith('/in-common')
        ? 'in-common'
        : 'followers';
  const tabs = [
    { id: 'followers', label: t('Followers', { defaultValue: 'Followers' }) },
    { id: 'following', label: t('Following', { defaultValue: 'Following' }) },
    { id: 'in-common', label: t('connections.tabs.inCommon', { defaultValue: 'In common' }) },
    { id: 'who-may-know', label: t('Who May Know', { defaultValue: 'Who May Know' }) },
  ];
  const selected = tabs.find((tab) => tab.id === active);
  const title =
    (active === 'followers' || active === 'following') && data?.design.displayName
      ? `${data.design.displayName} ${selected?.label}`
      : selected?.label;
  return (
    <PageHeader
      title={title}
      backLabel={t('common.back', { defaultValue: 'Back' })}
      accessory={
        <Tabs
          value={active}
          onValueChange={(tab) => router.push(`/@${handle}/${tab}`)}
          variant="underline"
        >
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} label={tab.label} />
          ))}
        </Tabs>
      }
    />
  );
}
