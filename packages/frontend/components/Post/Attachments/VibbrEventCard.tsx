import { useRef } from 'react';
import { Linking, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getEventUrl } from '@mention/shared-types/vibbr';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { vibbrEvents } from '@/lib/references/vibbrEvents';

import { RawText, VStack, toElement } from '@oxy.so/bloom-language';

/** Every state occupies the same box, so a card never shifts the feed when it resolves. */
export function VibbrEventCard({
  eventId,
  postId,
  width = '100%',
  height = 200,
}: {
  eventId: string;
  postId?: string;
  /** Points beside other cards; the row's full width ('100%', the default) alone. */
  width?: number | '100%';
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
  // One root: the card's own view is the viewability target (its ref).
  return toElement(
    VStack(
      RawText('Vibbr').foreground('muted').font('14').leading('20px'),
      value
        ? VStack(
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
            RawText(t('vibbr.open', { defaultValue: 'Open event in Vibbr' })).foreground('primary'),
          )
            .flex('1')
            .justify('center')
            .spacing('xs')
            .role('link')
            .label(t('vibbr.open', { defaultValue: 'Open event in Vibbr' }))
            .onPress((event) => {
              event.stopPropagation();
              void Linking.openURL(getEventUrl(eventId));
            })
        : VStack(
            RawText(
              state.status === 'loading'
                ? t('vibbr.loading', { defaultValue: 'Loading Vibbr event…' })
                : t('vibbr.unavailable', {
                    defaultValue: 'This Vibbr event is no longer available',
                  }),
            )
              .foreground('muted')
              .liveRegion('polite'),
          )
            .flex('1')
            .justify('center'),
    )
      .padding('lg')
      .frame({ width: width === '100%' ? 'full' : width, height })
      .background('card')
      .border('border', 'thin')
      .corner('lg')
      .clipped()
      .ref(cardRef)
      .testID('vibbr-event-card'),
  );
}
