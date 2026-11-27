import { useRef } from 'react';
import { BloomImage } from '@oxy.so/bloom/image';
import { Linking, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { commerceCards, recordCommerceHandoff } from '@/lib/references/commerceCards';

import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

/** Price and availability disappear as soon as current hydration expires or fails. */
export function CommerceCard({
  referenceId,
  postId,
  width,
  height = 260,
}: {
  referenceId: string;
  postId?: string;
  /** The cell's width from the row or the composer: points, or the row's full width ('100%'). */
  width?: number | '100%';
  height?: number;
}) {
  const { t, i18n } = useTranslation();
  const cardRef = useRef<ViewInstance>(null);
  const visible = useViewableVisible({ viewabilityKey: postId, target: cardRef });
  const state = useVisibleReference(commerceCards, referenceId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  const product = value && 'product' in value ? value.product : undefined;
  const collection = value && 'collection' in value ? value.collection : undefined;
  const image = product?.primaryImage ?? collection?.image;
  // One root: the card's own view is the viewability target (its ref).
  return toElement(
    VStack(
      image
        ? Embed(
            <BloomImage
              source={{ uri: image.url }}
              accessibilityLabel={image.alt ?? product?.title ?? collection?.title}
              style={{ width: '100%', height: Math.min(120, height * 0.4) }}
              contentFit="cover"
            />,
          )
        : null,
      VStack(
        RawText('Mercaria').foreground('muted').font('xs').leading('16px'),
        ...(value
          ? [
              RawText(product?.title ?? collection?.title)
                .foreground('foreground')
                .weight('semibold')
                .lines(2),
              product
                ? HStack(
                    RawText(value.formatPrice?.(i18n.language))
                      .foreground('foreground')
                      .font('14')
                      .leading('20px')
                      .lines(1),
                    product.availability !== 'in_stock'
                      ? RawText(
                          product.availability === 'sold'
                            ? t('commerce.availability.sold')
                            : t('commerce.availability.out_of_stock'),
                        )
                          .foreground('muted')
                          .font('xs')
                          .leading('16px')
                          .shrink('normal')
                          .lines(1)
                      : null,
                  )
                    .align('center')
                    .spacing('sm')
                : null,
              VStack(
                RawText(
                  t('commerce.continue', { defaultValue: 'Continue on Mercaria' }),
                ).foreground('primary'),
              )
                .padding('vertical', 'sm')
                .role('link')
                .label(t('commerce.continue', { defaultValue: 'Continue on Mercaria' }))
                .onPress((event) => {
                  event.stopPropagation();
                  if (postId) void recordCommerceHandoff(postId).catch(() => {});
                  void Linking.openURL(value.url);
                }),
            ]
          : [
              RawText(
                state.status === 'loading'
                  ? t('commerce.loading', { defaultValue: 'Checking current availability…' })
                  : t('commerce.unavailable', {
                      defaultValue: 'This item is currently unavailable',
                    }),
              )
                .foreground('muted')
                .liveRegion('polite'),
            ]),
      )
        .padding('all', 'md')
        .spacing('xs'),
    )
      .frame({ width: width === '100%' ? 'full' : width, height })
      .background('card')
      .border('border', 'thin')
      .corner('14')
      .clipped()
      .ref(cardRef)
      .testID('commerce-card'),
  );
}
