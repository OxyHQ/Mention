import { useProfileData } from '@/hooks/useProfileData';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import type { SettingsRowData } from '@oxy.so/bloom/settings-modal';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Embed, SettingsValue, VStack, toElement } from '@oxy.so/bloom-language';

type OxyProfileField = 'displayName' | 'username' | 'bio' | 'location' | 'links';

/**
 * The identity rows (photo, name, username and, with `full`, bio, location and
 * links). Those fields belong to the shared Oxy account, so every row closes
 * Settings and opens the matching Oxy screen rather than editing a copy here.
 */
export function useOxyIdentityRows({ full = false }: { full?: boolean } = {}): SettingsRowData[] {
  const { t } = useTranslation();
  const { user, showBottomSheet, openAvatarPicker } = useAuth();
  const { data: profile } = useProfileData(user?.username);
  const notSet = t('settings.editProfile.notSet', { defaultValue: 'Not set' });

  const value = (text: string | undefined, fieldType: OxyProfileField) =>
    toElement(
      VStack(SettingsValue(text || notSet).muted(!text))
        .onPress(() => showBottomSheet?.({ screen: 'EditProfileField', props: { fieldType } }))
        .role('button'),
    );

  const rows: SettingsRowData[] = [
    {
      key: 'avatar',
      label: t('settings.profile.photo', { defaultValue: 'Profile photo' }),
      control: toElement(
        VStack(
          Embed(
            <AccountAvatar
              account={profile ?? undefined}
              source={profile?.avatar}
              name={profile?.design.displayName ?? profile?.username}
              size={40}
              variant={MEDIA_VARIANT_AVATAR_LG}
            />,
          ),
        )
          .onPress(() => void openAvatarPicker())
          .role('button'),
      ),
    },
    {
      key: 'name',
      label: t('settings.profile.name', { defaultValue: 'Name' }),
      control: value(profile?.design.displayName, 'displayName'),
    },
    {
      key: 'handle',
      label: t('settings.profile.username', { defaultValue: 'Username' }),
      control: value(profile?.username && `@${profile.username}`, 'username'),
    },
  ];
  if (!full) return rows;
  const linkCount = profile?.links?.length ?? 0;
  return [
    ...rows,
    {
      key: 'bio',
      label: t('settings.profile.bio', { defaultValue: 'Bio' }),
      control: value(profile?.bio, 'bio'),
    },
    {
      key: 'location',
      label: t('settings.profile.location', { defaultValue: 'Location' }),
      control: value(profile?.primaryLocation, 'location'),
    },
    {
      key: 'links',
      label: t('settings.profile.links', { defaultValue: 'Links' }),
      control: value(
        linkCount
          ? t('settings.editProfile.linksCount', {
              count: linkCount,
              defaultValue: '{{count}} links',
            })
          : undefined,
        'links',
      ),
    },
  ];
}
