import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon } from '@/lib/icons';
import { useAppearanceStore } from '@/store/appearanceStore';

/**
 * Profile banner picker/preview — extracted from the old
 * `settings/appearance.tsx` "Profile header" section, unchanged in behavior.
 * Self-contained: reads/writes `useAppearanceStore` directly.
 */
export const BannerSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { showBottomSheet, oxyServices } = useAuth();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  const [headerImageId, setHeaderImageId] = useState<string>(mySettings?.profileHeaderImage ?? '');

  useEffect(() => {
    if (mySettings?.profileHeaderImage !== undefined) {
      setHeaderImageId(mySettings.profileHeaderImage || '');
    }
  }, [mySettings?.profileHeaderImage]);

  const openHeaderPicker = useCallback(() => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: { id: string; contentType?: string }) => {
          if (!file?.contentType?.startsWith?.('image/')) return;
          setHeaderImageId(file.id);
          await updateMySettings({ profileHeaderImage: file.id });
        },
      },
    });
  }, [showBottomSheet, updateMySettings]);

  const removeHeaderImage = useCallback(async () => {
    setHeaderImageId('');
    await updateMySettings({ profileHeaderImage: '' });
  }, [updateMySettings]);

  return (
    <View className="px-5 py-4 gap-3">
      <View className="flex-row items-center gap-3">
        <Icon name="image-outline" size={22} color={colors.text} />
        <Text className="text-[16px] text-foreground">
          {t('settings.profileHeader', 'Profile header')}
        </Text>
      </View>

      {headerImageId ? (
        <View className="rounded-xl overflow-hidden border border-border relative">
          <Image
            source={{ uri: oxyServices.getFileDownloadUrl(headerImageId, 'full') }}
            className="w-full h-32 bg-muted"
            resizeMode="cover"
          />
          <View className="absolute bottom-2 right-2 flex-row gap-1.5">
            <Pressable
              className="w-8 h-8 rounded-full items-center justify-center bg-black/60"
              onPress={openHeaderPicker}
            >
              <Icon name="camera-outline" size={16} color="#FFFFFF" />
            </Pressable>
            <Pressable
              className="w-8 h-8 rounded-full items-center justify-center bg-red-500/80"
              onPress={removeHeaderImage}
            >
              <Icon name="trash-outline" size={16} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          className="rounded-xl border-[1.5px] border-dashed border-border bg-secondary py-5 items-center gap-1.5"
          onPress={openHeaderPicker}
        >
          <View className="w-10 h-10 rounded-full items-center justify-center bg-muted">
            <Icon name="image-outline" size={20} color={colors.textSecondary} />
          </View>
          <Text className="text-sm font-semibold text-foreground">
            {t('settings.uploadHeader', 'Upload header image')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('settings.uploadHeaderHint', 'Recommended: 1500x500px')}
          </Text>
        </Pressable>
      )}
    </View>
  );
};
