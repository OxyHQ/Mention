import React, { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services/ui/client';
import { useTheme } from '@oxyhq/bloom/theme';
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
    <View className="px-5 py-3 gap-3">
      <View className="flex-row items-center gap-3">
        <Icon name="image-outline" size={22} color={colors.text} />
        <Text className="text-[16px] text-foreground">
          {t('settings.profileHeader', 'Profile header')}
        </Text>
      </View>

      {headerImageRef ? (
        <View className="rounded-xl overflow-hidden border border-border relative">
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
            className="w-full h-32 bg-muted"
            contentFit="cover"
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
          className="rounded-xl border-[1.5px] border-dashed border-border bg-muted py-5 items-center gap-1.5"
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
