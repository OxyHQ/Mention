import { commerceService } from '@/services/commerceService';
import { Image } from 'expo-image';
import { Linking, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useReferenceVisibility } from '@/hooks/useReferenceVisibility';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { commerceCards } from '@/lib/references/commerceCards';
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
  const { nativeID, visible } = useReferenceVisibility(postId);
  const state = useVisibleReference(commerceCards, referenceId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  const product = value && 'product' in value ? value.product : undefined;
  const collection = value && 'collection' in value ? value.collection : undefined;
  const image = product?.primaryImage ?? collection?.image;
  return (
    <View
      nativeID={nativeID}
      testID="commerce-card"
      style={{ height }}
      className={cn('border border-border bg-card rounded-[14px] overflow-hidden', className)}
    >
      {image ? (
        <Image
          source={{ uri: image.url }}
          accessibilityLabel={image.alt ?? product?.title ?? collection?.title}
          style={{ width: '100%', height: Math.min(140, height * 0.45) }}
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
              <Text className="text-foreground">{value.formatPrice?.(i18n.language)}</Text>
            ) : null}
            {product && product.availability !== 'in_stock' ? (
              <Text className="text-muted-foreground">
                {product.availability === 'sold'
                  ? t('commerce.availability.sold')
                  : t('commerce.availability.out_of_stock')}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('commerce.continue', { defaultValue: 'Continue on Mercaria' })}
              onPress={(event) => {
                event.stopPropagation();
                if (postId)
                  void commerceService.recordMetric('posts', postId, 'handoff').catch(() => {});
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
