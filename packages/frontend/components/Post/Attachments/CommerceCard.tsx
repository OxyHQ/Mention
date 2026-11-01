import { useRef } from 'react';
import { Image } from 'expo-image';
import { Linking, Pressable, Text, View, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { commerceCards, recordCommerceHandoff } from '@/lib/references/commerceCards';
import { cn } from '@/lib/utils';

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
      <View className="p-3 gap-1">
        <Text className="text-muted-foreground text-xs">Mercaria</Text>
        {value ? (
          <>
            <Text className="text-foreground font-semibold" numberOfLines={2}>
              {product?.title ?? collection?.title}
            </Text>
            {product ? (
              <View className="flex-row items-center gap-2">
                <Text className="text-foreground text-sm" numberOfLines={1}>
                  {value.formatPrice?.(i18n.language)}
                </Text>
                {product.availability !== 'in_stock' ? (
                  <Text className="text-muted-foreground text-xs flex-shrink" numberOfLines={1}>
                    {product.availability === 'sold'
                      ? t('commerce.availability.sold')
                      : t('commerce.availability.out_of_stock')}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('commerce.continue', { defaultValue: 'Continue on Mercaria' })}
              onPress={(event) => {
                event.stopPropagation();
                if (postId) void recordCommerceHandoff(postId).catch(() => {});
                void Linking.openURL(value.url);
              }}
              className="py-2"
            >
              <Text className="text-primary">
                {t('commerce.continue', { defaultValue: 'Continue on Mercaria' })}
              </Text>
            </Pressable>
          </>
        ) : (
          <Text accessibilityLiveRegion="polite" className="text-muted-foreground">
            {state.status === 'loading'
              ? t('commerce.loading', { defaultValue: 'Checking current availability…' })
              : t('commerce.unavailable', { defaultValue: 'This item is currently unavailable' })}
          </Text>
        )}
      </View>
    </View>
  );
}
