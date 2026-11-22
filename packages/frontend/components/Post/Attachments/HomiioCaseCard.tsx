import { useRef } from 'react';
import { Linking, Text, View, type DimensionValue, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getHomiioCaseUrl } from '@mention/shared-types/homiio';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { homiioCases } from '@/lib/references/homiioCases';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

/** Every state occupies the same box. The public SDK has no exact address field. */
export function HomiioCaseCard({
  caseId,
  postId,
  width = '100%',
  height = 200,
}: {
  caseId: string;
  postId?: string;
  width?: DimensionValue;
  height?: number;
}) {
  const { t } = useTranslation();
  const cardRef = useRef<ViewInstance>(null);
  const visible = useViewableVisible({ viewabilityKey: postId, target: cardRef });
  const state = useVisibleReference(homiioCases, caseId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  return (
    <View
      ref={cardRef}
      testID="homiio-case-card"
      style={{ width, height }}
      className="rounded-2xl border border-border bg-card p-4 overflow-hidden"
    >
      {toElement(RawText('Homiio').foreground('muted').font('14').leading('20px'))}
      {value
        ? toElement(
            VStack(
              RawText(value.title).foreground('foreground').weight('semibold').lines(2),
              RawText(value.area.label).foreground('muted').lines(1),
              RawText(new Date(value.scheduledAt).toLocaleString()).foreground('muted'),
              RawText(
                t(`homiio.status.${value.status}`, { defaultValue: value.status }),
              ).foreground('muted'),
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
              }),
          )
        : toElement(
            VStack(
              Embed(
                <Text accessibilityLiveRegion="polite" className="text-muted-foreground">
                  {state.status === 'loading'
                    ? t('homiio.loading', { defaultValue: 'Loading Homiio case…' })
                    : t('homiio.unavailable', { defaultValue: 'This Homiio case is unavailable' })}
                </Text>,
              ),
            )
              .flex('1')
              .justify('center'),
          )}
    </View>
  );
}
