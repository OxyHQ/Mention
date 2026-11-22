import { useRef } from 'react';
import { Linking, Text, View, type DimensionValue, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getEventUrl } from '@mention/shared-types/vibbr';
import { createTokenStyles } from '@oxy.so/bloom/theme';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { vibbrEvents } from '@/lib/references/vibbrEvents';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

// The card keeps its React Native view: its ref is the viewability target, which
// a language stack does not hand out. Its loading line keeps React Native's Text
// for `accessibilityLiveRegion`, which the language has no modifier for.
const useStyles = createTokenStyles((t) => ({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.card,
    padding: 16,
    overflow: 'hidden',
  },
  status: { color: t.mutedForeground },
}));

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
  const styles = useStyles();
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
    <View ref={cardRef} testID="vibbr-event-card" style={[styles.card, { width, height }]}>
      {toElement(RawText('Vibbr').foreground('muted').font('14').leading('20px'))}
      {value
        ? toElement(
            VStack(
              RawText(value.title).foreground('foreground').weight('semibold').lines(2),
              RawText(
                [value.venueName, value.city].filter(Boolean).join(' · ') || value.organizerName,
              )
                .foreground('muted')
                .lines(1),
              RawText(when).foreground('muted'),
              RawText(
                value.status === 'cancelled'
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
                        : '',
              ).foreground('muted'),
              RawText(t('vibbr.open', { defaultValue: 'Open event in Vibbr' })).foreground(
                'primary',
              ),
            )
              .flex('1')
              .justify('center')
              .spacing('xs')
              .role('link')
              .label(t('vibbr.open', { defaultValue: 'Open event in Vibbr' }))
              .onPress((event) => {
                event.stopPropagation();
                void Linking.openURL(getEventUrl(eventId));
              }),
          )
        : toElement(
            VStack(
              Embed(
                <Text accessibilityLiveRegion="polite" style={styles.status}>
                  {state.status === 'loading'
                    ? t('vibbr.loading', { defaultValue: 'Loading Vibbr event…' })
                    : t('vibbr.unavailable', {
                        defaultValue: 'This Vibbr event is no longer available',
                      })}
                </Text>,
              ),
            )
              .flex('1')
              .justify('center'),
          )}
    </View>
  );
}
