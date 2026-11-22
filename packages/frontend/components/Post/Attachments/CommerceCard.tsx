import { useRef } from 'react';
import { Image } from 'expo-image';
import { Linking, Text, View, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { commerceCards, recordCommerceHandoff } from '@/lib/references/commerceCards';
import { cn } from '@/lib/utils';

import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

/** Price and availability disappear as soon as current hydration expires or fails. */
export function CommerceCard({
  referenceId,
  postId,
  className,
  height = 260,
}: {
  referenceId: string;
  postId?: string;
  className?: string;
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
  return (
    <View
      ref={cardRef}
      testID="commerce-card"
      style={{ height }}
      className={cn('border border-border bg-card rounded-[14px] overflow-hidden', className)}
    >
      {image ? (
        <Image
          source={{ uri: image.url }}
          accessibilityLabel={image.alt ?? product?.title ?? collection?.title}
          style={{ width: '100%', height: Math.min(120, height * 0.4) }}
          contentFit="cover"
        />
      ) : null}
      {toElement(
        VStack(
          RawText('Mercaria').foreground('muted').font('xs').leading('16px'),
          Embed(
            value ? (
              <>
                {toElement(
                  RawText(product?.title ?? collection?.title)
                    .foreground('foreground')
                    .weight('semibold')
                    .lines(2),
                )}
                {product
                  ? toElement(
                      HStack(
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
                        .spacing('sm'),
                    )
                  : null}
                {toElement(
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
                )}
              </>
            ) : (
              <Text accessibilityLiveRegion="polite" className="text-muted-foreground">
                {state.status === 'loading'
                  ? t('commerce.loading', { defaultValue: 'Checking current availability…' })
                  : t('commerce.unavailable', {
                      defaultValue: 'This item is currently unavailable',
                    })}
              </Text>
            ),
          ),
        )
          .padding('all', 'md')
          .spacing('xs'),
      )}
    </View>
  );
}
