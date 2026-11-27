import { getNormalizedUserHandle } from '@oxy.so/core';
import { useTranslation } from 'react-i18next';
import { usePathname, useRouter } from '@/lib/navigation/router';
import type { ProfileData } from '@/hooks/useProfileData';
import { connectionTabFromPathname } from './profileTabRoute';

import { Header, toElement } from '@oxy.so/bloom-language';
import { TabItem, Tabs as LTabs } from '@oxy.so/bloom-language/containers';

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
  return toElement(
    Header(title)
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .accessory(
        LTabs(
          [active, (tab) => router.push(`/@${handle}/${tab}`)],
          tabs.map((tab) => TabItem(tab.id, tab.label)),
        ).style('underline'),
      )
      .inPage(),
  );
}
