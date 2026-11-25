import { useRef } from 'react';
import { Image } from 'expo-image';
import { Linking, View, type StyleProp, type ViewInstance, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createTokenStyles } from '@oxy.so/bloom/theme';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { commerceCards, recordCommerceHandoff } from '@/lib/references/commerceCards';

import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

// The card keeps its React Native view: its ref is the viewability target, which
// a language stack does not hand out.
const useStyles = createTokenStyles((t) => ({
  card: {
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.card,
    borderRadius: 14,
    overflow: 'hidden',
  },
}));

/** Price and availability disappear as soon as current hydration expires or fails. */
export function CommerceCard({
  referenceId,
  postId,
  style,
  height = 260,
}: {
  referenceId: string;
  postId?: string;
  /** The cell's size from the row or the composer (its width). */
  style?: StyleProp<ViewStyle>;
  height?: number;
}) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const cardRef = useRef<ViewInstance>(null);
  const visible = useViewableVisible({ viewabilityKey: postId, target: cardRef });
  const state = useVisibleReference(commerceCards, referenceId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  const product = value && 'product' in value ? value.product : undefined;
  const collection = value && 'collection' in value ? value.collection : undefined;
  const image = product?.primaryImage ?? collection?.image;
  return (
    <View ref={cardRef} testID="commerce-card" style={[styles.card, style, { height }]}>
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
              toElement(
                RawText(
                  state.status === 'loading'
                    ? t('commerce.loading', { defaultValue: 'Checking current availability…' })
                    : t('commerce.unavailable', {
                        defaultValue: 'This item is currently unavailable',
                      }),
                )
                  .foreground('muted')
                  .liveRegion('polite'),
              )
            ),
          ),
        )
          .padding('all', 'md')
          .spacing('xs'),
      )}
    </View>
  );
}
