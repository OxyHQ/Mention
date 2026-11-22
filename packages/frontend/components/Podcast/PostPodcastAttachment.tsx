import { useRef } from 'react';
import { Text, View, type DimensionValue, type ViewInstance, type ViewStyle } from 'react-native';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type { PostPodcastContent } from '@mention/shared-types/post';
import { useViewableVisible } from '@oxy.so/bloom/video-playback';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { syraPodcastCards } from '@/lib/references/syraPodcastCards';
import { PodcastCard } from './PodcastCard';
import { PodcastSaveButton } from './PodcastSaveButton';

import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

// The card's box stays a view (it is measured for visibility and sized by its post);
// this draws its classes, `rounded-2xl overflow-hidden`. Its status text stays
// React Native's Text, a polite live region the language has no modifier for.
const attachmentBox: ViewStyle = { borderRadius: 16, overflow: 'hidden' };

/** Even cached pre-migration feed objects contribute ONLY their ID. */
export function PostPodcastAttachment({
  podcast,
  postId,
  width,
  height = 200,
  showSaveButton = true,
  onPress,
}: {
  podcast: PostPodcastContent;
  postId?: string;
  width: DimensionValue;
  height?: number;
  showSaveButton?: boolean;
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const colors = useColorTokens();
  const cardRef = useRef<ViewInstance>(null);
  const visible = useViewableVisible({ viewabilityKey: postId, target: cardRef });
  const state = useVisibleReference(syraPodcastCards, podcast.syraPodcastId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  return (
    <View ref={cardRef} testID="syra-podcast-card" style={[attachmentBox, { width, height }]}>
      {value ? (
        <PodcastCard
          title={value.title}
          author={value.author}
          artworkUrl={value.artworkUrl}
          showUrl={value.showUrl}
          width="100%"
          height={height}
          onPress={onPress}
          saveButton={showSaveButton ? <PodcastSaveButton podcastId={value.id} /> : undefined}
        />
      ) : (
        toElement(
          VStack(
            Embed(
              <Text accessibilityLiveRegion="polite" style={{ color: colors.mutedForeground }}>
                {state.status === 'loading'
                  ? t('podcast.loading', { defaultValue: 'Loading Syra podcast…' })
                  : t('podcast.unavailable', { defaultValue: 'This Syra podcast is unavailable' })}
              </Text>,
            ),
          )
            .padding('all', 'lg')
            .background('card')
            .flex('1')
            .justify('center'),
        )
      )}
    </View>
  );
}
