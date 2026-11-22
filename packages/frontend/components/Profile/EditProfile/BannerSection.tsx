import type React from 'react';
import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { MEDIA_VARIANT_BANNER } from '@mention/shared-types/post';
import { useAppearanceStore } from '@/stores/appearanceStore';

import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
const BANNER_PREVIEW_STYLE = { width: '100%', aspectRatio: 3 } as const;

export const BannerSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { showBottomSheet, oxyServices } = useAuth();
  const headerImageRef = useAppearanceStore((state) => state.mySettings?.profileHeaderImage ?? '');
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  // The store paints the pick at once and rolls it back if the save fails;
  // say so then, rather than quietly showing the old banner again.
  const saveHeaderImage = useCallback(
    async (profileHeaderImage: string) => {
      if (!(await updateMySettings({ profileHeaderImage }))) {
        toast.error(t('settings.saveFailed'));
      }
    },
    [updateMySettings, t],
  );

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
          await saveHeaderImage(file.id);
        },
      },
    });
  }, [showBottomSheet, saveHeaderImage]);

  const removeHeaderImage = useCallback(() => saveHeaderImage(''), [saveHeaderImage]);

  return toElement(
    VStack(
      VStack(
        HStack(
          Embed(<RiImageLine width={22} fill={colors.text} />),
          RawText(t('settings.profileHeader', 'Profile header'))
            .font('16')
            .weight('semibold')
            .foreground('foreground'),
        )
          .align('center')
          .spacing('md'),
        Embed(
          <Text className="text-sm text-muted-foreground pl-[34px]">
            {t('settings.uploadHeaderHint', 'Recommended: 1500x500px')}
          </Text>,
        ),
      ).spacing('xs'),
      Embed(
        headerImageRef ? (
          toElement(
            VStack(
              Embed(
                <Image
                  source={{
                    // Same variant the profile banner asks for, so this preview and
                    // the profile share ONE cache entry instead of pulling two
                    // differently-sized copies of the picked image.
                    uri: oxyServices.assets.renderUrl(headerImageRef, MEDIA_VARIANT_BANNER),
                  }}
                  // expo-image is not a react-native core view, so a className does
                  // not size it on native; the frame is the image's own style.
                  style={BANNER_PREVIEW_STYLE}
                  contentFit="cover"
                />,
              ),
              Embed(
                <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between bg-black/60 px-3 py-2">
                  {toElement(
                    HStack(
                      Embed(<RiCameraLine width={17} fill={colors.primaryForeground} />),
                      RawText(t('common.edit'))
                        .foreground('white')
                        .font('14')
                        .leading('20px')
                        .weight('semibold'),
                    )
                      .align('center')
                      .spacing('sm'),
                  )}
                  {toElement(
                    VStack(Embed(<RiDeleteBinLine width={17} fill={colors.primaryForeground} />))
                      .frame({ width: '36', height: '36' })
                      .background('black/40')
                      .corner('infinite')
                      .align('center')
                      .justify('center')
                      .onPress((event) => {
                        event.stopPropagation();
                        void removeHeaderImage();
                      })
                      .role('button')
                      .label(`${t('common.remove')} ${t('settings.profileHeader')}`),
                  )}
                </View>,
              ),
            )
              .background('mutedFill')
              .border('border', 'thin')
              .corner('lg')
              .clipped()
              .onPress(openHeaderPicker)
              .role('button')
              .label(`${t('common.edit')} ${t('settings.profileHeader')}`),
          )
        ) : (
          <Pressable
            className="aspect-[3/1] min-h-28 rounded-2xl border-[1.5px] border-dashed border-border bg-muted items-center justify-center gap-2"
            onPress={openHeaderPicker}
            accessibilityRole="button"
            accessibilityLabel={t('settings.uploadHeader', 'Upload header image')}
          >
            {toElement(
              VStack(Embed(<RiCameraLine width={21} fill={colors.primary} />))
                .frame({ width: '44', height: '44' })
                .background('primary/10')
                .corner('infinite')
                .align('center')
                .justify('center'),
            )}
            {toElement(
              RawText(t('settings.uploadHeader', 'Upload header image'))
                .font('14')
                .leading('20px')
                .weight('semibold')
                .foreground('foreground'),
            )}
          </Pressable>
        ),
      ),
    )
      .padding('horizontal', 'xl')
      .padding('vertical', 'lg')
      .spacing('md'),
  );
};
