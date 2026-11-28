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
import { getHomiioCaseUrl } from '@mention/shared-types/homiio';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { homiioCases } from '@/lib/references/homiioCases';

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
      <Text className="text-muted-foreground text-sm">Homiio</Text>
      {value ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('homiio.open', { defaultValue: 'Open case in Homiio' })}
          onPress={(event) => {
            event.stopPropagation();
            void Linking.openURL(getHomiioCaseUrl(caseId));
          }}
          className="flex-1 justify-center gap-1"
        >
          <Text numberOfLines={2} className="text-foreground font-semibold">
            {value.title}
          </Text>
          <Text numberOfLines={1} className="text-muted-foreground">
            {value.area.label}
          </Text>
          <Text className="text-muted-foreground">
            {new Date(value.scheduledAt).toLocaleString()}
          </Text>
          <Text className="text-muted-foreground">
            {t(`homiio.status.${value.status}`, { defaultValue: value.status })}
          </Text>
          <Text className="text-primary">
            {t('homiio.open', { defaultValue: 'Open case in Homiio' })}
          </Text>
        </Pressable>
      ) : (
        <View className="flex-1 justify-center">
          <Text accessibilityLiveRegion="polite" className="text-muted-foreground">
            {state.status === 'loading'
              ? t('homiio.loading', { defaultValue: 'Loading Homiio case…' })
              : t('homiio.unavailable', { defaultValue: 'This Homiio case is unavailable' })}
          </Text>
        </View>
      )}
    </View>
  );
}
