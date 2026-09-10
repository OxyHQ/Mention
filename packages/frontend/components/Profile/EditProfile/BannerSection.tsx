import React, { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { MEDIA_VARIANT_BANNER } from '@mention/shared-types/post';
import { Icon } from '@/lib/icons';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { useAppearanceStore } from '@/stores/appearanceStore';

/**
 * Profile banner picker/preview. Self-contained: reads/writes
 * `useAppearanceStore` directly.
 *
 * The store is the SINGLE source of truth for the current banner: the preview
 * renders `mySettings.profileHeaderImage` directly rather than mirroring it into
 * local state. The store paints the pick optimistically and rolls back on a
 * failed save, so the preview follows the picked image on the tap yet still ends
 * up showing the banner that is actually stored if the write never lands — no
 * second copy of the value here to drift out of sync.
 */
export const BannerSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { showBottomSheet, oxyServices } = useAuth();
  const headerImageRef = useAppearanceStore(
    (state) => state.mySettings?.profileHeaderImage ?? '',
  );
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  const openHeaderPicker = useCallback(() => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        // A banner is public-facing: an anonymous <img> on a profile page cannot
        // send a bearer token, so the asset must be public or the CDN 404s. The
        // picker defaults to `private` and would otherwise DEMOTE an already
        // public banner on re-pick, leaving it broken until the backend's
        // post-write promotion lands (and permanently if that write fails).
        defaultVisibility: 'public',
        afterSelect: 'back',
        onSelect: async (file: { id: string; contentType?: string }) => {
          if (!file?.contentType?.startsWith?.('image/')) return;
          await updateMySettings({ profileHeaderImage: file.id });
        },
      },
    });
  }, [showBottomSheet, updateMySettings]);

  const removeHeaderImage = useCallback(async () => {
    await updateMySettings({ profileHeaderImage: '' });
  }, [updateMySettings]);

  return (
    <View className="px-5 py-4 gap-3">
      <View className="gap-1">
        <View className="flex-row items-center gap-3">
          <Icon name="image-outline" size={22} color={colors.text} />
          <Text className="text-[16px] font-semibold text-foreground">
            {t('settings.profileHeader', 'Profile header')}
          </Text>
        </View>
        <Text className="text-sm text-muted-foreground pl-[34px]">
          {t('settings.uploadHeaderHint', 'Recommended: 1500x500px')}
        </Text>
      </View>

      {headerImageRef ? (
        <Pressable
          className="rounded-2xl overflow-hidden border border-border relative bg-muted"
          onPress={openHeaderPicker}
          accessibilityRole="button"
          accessibilityLabel={`${t('common.edit')} ${t('settings.profileHeader')}`}
        >
          <Image
            source={{
              // Same variant the profile banner asks for, so this preview and
              // the profile share ONE cache entry instead of pulling two
              // differently-sized copies of the picked image.
              uri: getCachedFileDownloadUrlSync(
                oxyServices,
                headerImageRef,
                MEDIA_VARIANT_BANNER,
              ),
            }}
            className="w-full aspect-[3/1] bg-muted"
            contentFit="cover"
          />
          <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between bg-black/60 px-3 py-2">
            <View className="flex-row items-center gap-2">
              <Icon name="camera-outline" size={17} color={colors.primaryForeground} />
              <Text className="text-white text-sm font-semibold">
                {t('common.edit')}
              </Text>
            </View>
            <Pressable
              className="w-9 h-9 rounded-full items-center justify-center bg-black/40"
              onPress={(event) => {
                event.stopPropagation();
                void removeHeaderImage();
              }}
              accessibilityRole="button"
              accessibilityLabel={`${t('common.remove')} ${t('settings.profileHeader')}`}
            >
              <Icon name="trash-outline" size={17} color={colors.primaryForeground} />
            </Pressable>
          </View>
        </Pressable>
      ) : (
        <Pressable
          className="aspect-[3/1] min-h-28 rounded-2xl border-[1.5px] border-dashed border-border bg-muted items-center justify-center gap-2"
          onPress={openHeaderPicker}
          accessibilityRole="button"
          accessibilityLabel={t('settings.uploadHeader', 'Upload header image')}
        >
          <View className="w-11 h-11 rounded-full items-center justify-center bg-primary/10">
            <Icon name="camera-outline" size={21} color={colors.primary} />
          </View>
          <Text className="text-sm font-semibold text-foreground">
            {t('settings.uploadHeader', 'Upload header image')}
          </Text>
        </Pressable>
      )}
    </View>
  );
};
