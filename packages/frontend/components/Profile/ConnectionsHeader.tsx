import { PageHeader } from '@oxy.so/bloom/page-header';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useTranslation } from 'react-i18next';
import { usePathname, useRouter } from '@/lib/navigation/router';
import type { ProfileData } from '@/hooks/useProfileData';
import { connectionTabFromPathname } from './profileTabRoute';

export function ConnectionsHeader({
  username,
  profileData,
}: {
  /** The routed handle, its `@` already stripped by `useRoutedProfileUsername`. */
  username: string;
  profileData: ProfileData | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const data = profileData;
  const { t } = useTranslation();
  const handle =
    getNormalizedUserHandle({
      username: data?.username || username,
      instance: data?.instance,
      isFederated: data?.isFederated,
    }) || username;
  const active = connectionTabFromPathname(pathname) ?? 'followers';
  const tabs = [
    { id: 'followers', label: t('profile.followers', { defaultValue: 'Followers' }) },
    { id: 'following', label: t('common.following', { defaultValue: 'Following' }) },
    { id: 'in-common', label: t('connections.tabs.inCommon', { defaultValue: 'In common' }) },
    {
      id: 'who-may-know',
      label: t('profile.connections.whoMayKnow', { defaultValue: 'Who May Know' }),
    },
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
