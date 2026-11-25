import type React from 'react';
import { useCallback } from 'react';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { MEDIA_VARIANT_BANNER } from '@mention/shared-types/post';
import { useAppearanceStore } from '@/stores/appearanceStore';

import {
  Embed,
  HStack,
  Icon,
  RawText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

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

/**
 * The hint lines up under the title, past its 22pt glyph and the 12pt gap; the
 * empty banner is at least 112pt tall.
 */
const banner = defineTokens({ space: { hintInset: 34, emptyMinHeight: 112 } });
// What the classes drew, as plain objects (inline, as the classes were).
/** The edit bar along the preview's bottom: black at 60% under the glyphs. */
export const BannerSection: React.FC = () => {
  const { t } = useTranslation();
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
          Icon(RiImageLine).size('22').foreground('foreground'),
          RawText(t('settings.profileHeader', 'Profile header'))
            .font('16')
            .weight('semibold')
            .foreground('foreground'),
        )
          .align('center')
          .spacing('md'),
        RawText(t('settings.uploadHeaderHint', 'Recommended: 1500x500px'))
          .font('14')
          .leading('20px')
          .foreground('muted')
          .padding('left', banner.space.hintInset),
      ).spacing('xs'),
      headerImageRef
        ? VStack(
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
            // The bar spans the preview by its inline insets.
            HStack(
              HStack(
                Icon(RiCameraLine).size('17').foreground('onPrimary'),
                RawText(t('common.edit'))
                  .foreground('white')
                  .font('14')
                  .leading('20px')
                  .weight('semibold'),
              )
                .align('center')
                .spacing('sm'),
              VStack(Icon(RiDeleteBinLine).size('17').foreground('onPrimary'))
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
            )
              .position({ horizontal: 'none', bottom: 'none' })
              .padding('horizontal', 'md')
              .padding('vertical', 'sm')
              .background('black/60')
              .align('center')
              .justify('between'),
          )
            .background('mutedFill')
            .border('border', 'thin')
            .corner('lg')
            .clipped()
            .onPress(openHeaderPicker)
            .role('button')
            .label(`${t('common.edit')} ${t('settings.profileHeader')}`)
        : // The empty banner: a 3:1 drop target at least 112pt tall, its outline dashed.
          VStack(
            VStack(Icon(RiCameraLine).size('21').foreground('primary'))
              .frame({ width: '44', height: '44' })
              .background('primary/10')
              .corner('infinite')
              .align('center')
              .justify('center'),
            RawText(t('settings.uploadHeader', 'Upload header image'))
              .font('14')
              .leading('20px')
              .weight('semibold')
              .foreground('foreground'),
          )
            .align('center')
            .justify('center')
            .spacing('sm')
            .aspectRatio(3)
            .frame({ minHeight: banner.space.emptyMinHeight })
            .background('mutedFill')
            .border('border', '1.5')
            .borderStyle('dashed')
            .corner('lg')
            .onPress(openHeaderPicker)
            .role('button')
            .label(t('settings.uploadHeader', 'Upload header image')),
    )
      .padding('horizontal', 'xl')
      .padding('vertical', 'lg')
      .spacing('md'),
  );
};
