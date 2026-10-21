import { useMentionSettings } from '@/context/MentionSettingsContext';
import { useProfileData } from '@/hooks/useProfileData';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { Avatar } from '@oxy.so/bloom/avatar';
import { SettingsValueField, type SettingsRowData } from '@oxy.so/bloom/settings-modal';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';

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
  const { afterClose } = useMentionSettings();
  const notSet = t('settings.editProfile.notSet', { defaultValue: 'Not set' });

  const value = (text: string | undefined, fieldType: OxyProfileField) => (
    <Pressable
      onPress={() =>
        afterClose(() => showBottomSheet?.({ screen: 'EditProfileField', props: { fieldType } }))
      }
      accessibilityRole="button"
    >
      <SettingsValueField muted={!text}>{text || notSet}</SettingsValueField>
    </Pressable>
  );

  const rows: SettingsRowData[] = [
    {
      key: 'avatar',
      label: t('settings.profile.photo', { defaultValue: 'Profile photo' }),
      control: (
        <Pressable
          onPress={() => afterClose(() => void openAvatarPicker())}
          accessibilityRole="button"
        >
          <Avatar
            source={profile?.avatar}
            name={profile?.design.displayName ?? profile?.username}
            size={40}
            variant={MEDIA_VARIANT_AVATAR_LG}
          />
        </Pressable>
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
