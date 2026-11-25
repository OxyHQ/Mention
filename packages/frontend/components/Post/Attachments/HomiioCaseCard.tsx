import { useRef } from 'react';
import { Linking, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getHomiioCaseUrl } from '@mention/shared-types/homiio';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { homiioCases } from '@/lib/references/homiioCases';

import { RawText, VStack, toElement } from '@oxy.so/bloom-language';

/** Every state occupies the same box. The public SDK has no exact address field. */
export function HomiioCaseCard({
  caseId,
  postId,
  width = '100%',
  height = 200,
}: {
  caseId: string;
  postId?: string;
  /** Points beside other cards; the row's full width ('100%', the default) alone. */
  width?: number | '100%';
  height?: number;
}) {
  const { t } = useTranslation();
  const cardRef = useRef<ViewInstance>(null);
  const visible = useViewableVisible({ viewabilityKey: postId, target: cardRef });
  const state = useVisibleReference(homiioCases, caseId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  // One root: the card's own view is the viewability target (its ref).
  return toElement(
    VStack(
      RawText('Homiio').foreground('muted').font('14').leading('20px'),
      value
        ? VStack(
            RawText(value.title).foreground('foreground').weight('semibold').lines(2),
            RawText(value.area.label).foreground('muted').lines(1),
            RawText(new Date(value.scheduledAt).toLocaleString()).foreground('muted'),
            RawText(t(`homiio.status.${value.status}`, { defaultValue: value.status })).foreground(
              'muted',
            ),
            RawText(t('homiio.open', { defaultValue: 'Open case in Homiio' })).foreground(
              'primary',
            ),
          )
            .flex('1')
            .justify('center')
            .spacing('xs')
            .role('link')
            .label(t('homiio.open', { defaultValue: 'Open case in Homiio' }))
            .onPress((event) => {
              event.stopPropagation();
              void Linking.openURL(getHomiioCaseUrl(caseId));
            })
        : VStack(
            RawText(
              state.status === 'loading'
                ? t('homiio.loading', { defaultValue: 'Loading Homiio case…' })
                : t('homiio.unavailable', { defaultValue: 'This Homiio case is unavailable' }),
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
      .testID('homiio-case-card'),
  );
}
