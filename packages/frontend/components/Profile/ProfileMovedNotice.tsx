import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { useTheme } from '@oxy.so/bloom/theme';
import type { RemoteProfileMove } from '@mention/shared-types/profile';
import { profileBasePath } from './profileRoute';

interface ProfileMovedNoticeProps {
  movedTo: RemoteProfileMove;
}

/**
 * "This account has moved to @new@server" on a federated profile whose owner
 * announced a verified `Move` to another server — the notice Mastodon shows on a
 * moved account. Tapping it opens the new account's profile here.
 */
export const ProfileMovedNotice = memo(function ProfileMovedNotice({ movedTo }: ProfileMovedNoticeProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const label = t('profile.movedTo', {
    handle: movedTo.handle,
    defaultValue: 'This account has moved to @{{handle}}',
  });

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => router.push(profileBasePath('person', movedTo.handle))}
      className="flex-row items-center gap-2 rounded-xl px-3 py-2 mt-1 mb-2 bg-muted"
    >
      <View className="flex-1">
        <Text className="text-foreground text-sm font-medium" numberOfLines={2}>
          {label}
        </Text>
      </View>
      <RiArrowRightLine size="sm" fill={theme.colors.textSecondary} />
    </Pressable>
  );
});
