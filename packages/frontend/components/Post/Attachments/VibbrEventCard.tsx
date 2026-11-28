import { useRef } from 'react';
import {
  Linking,
  Pressable,
  Text,
  View,
  type DimensionValue,
  type ViewInstance,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { getEventUrl } from '@mention/shared-types/vibbr';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { vibbrEvents } from '@/lib/references/vibbrEvents';

/** Every state occupies the same box, so a card never shifts the feed when it resolves. */
export function VibbrEventCard({
  eventId,
  postId,
  width = '100%',
  height = 200,
}: {
  eventId: string;
  postId?: string;
  width?: DimensionValue;
  height?: number;
}) {
  const { t, i18n } = useTranslation();
  const cardRef = useRef<ViewInstance>(null);
  const visible = useViewableVisible({ viewabilityKey: postId, target: cardRef });
  const state = useVisibleReference(vibbrEvents, eventId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  const when = value
    ? new Intl.DateTimeFormat(i18n.language, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: value.timeZone,
      }).format(new Date(value.startsAt))
    : undefined;
  return (
    <View
      ref={cardRef}
      testID="vibbr-event-card"
      style={{ width, height }}
      className="rounded-2xl border border-border bg-card p-4 overflow-hidden"
    >
      <Text className="text-muted-foreground text-sm">Vibbr</Text>
      {value ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('vibbr.open', { defaultValue: 'Open event in Vibbr' })}
          onPress={(event) => {
            event.stopPropagation();
            void Linking.openURL(getEventUrl(eventId));
          }}
          className="flex-1 justify-center gap-1"
        >
          <Text numberOfLines={2} className="text-foreground font-semibold">
            {value.title}
          </Text>
          <Text numberOfLines={1} className="text-muted-foreground">
            {[value.venueName, value.city].filter(Boolean).join(' · ') || value.organizerName}
          </Text>
          <Text className="text-muted-foreground">{when}</Text>
          <Text className="text-muted-foreground">
            {value.status === 'cancelled'
              ? t('vibbr.cancelled', { defaultValue: 'Cancelled' })
              : value.soldOut
                ? t('vibbr.soldOut', { defaultValue: 'Sold out' })
                : value.free
                  ? t('vibbr.free', { defaultValue: 'Free' })
                  : value.priceFrom
                    ? new Intl.NumberFormat(i18n.language, {
                        style: 'currency',
                        currency: value.priceFrom.currency,
                      }).format(Number(value.priceFrom.amount) / 100)
                    : ''}
          </Text>
          <Text className="text-primary">
            {t('vibbr.open', { defaultValue: 'Open event in Vibbr' })}
          </Text>
        </Pressable>
      ) : (
        <View className="flex-1 justify-center">
          <Text accessibilityLiveRegion="polite" className="text-muted-foreground">
            {state.status === 'loading'
              ? t('vibbr.loading', { defaultValue: 'Loading Vibbr event…' })
              : t('vibbr.unavailable', { defaultValue: 'This Vibbr event is no longer available' })}
          </Text>
        </View>
      )}
    </View>
  );
}
