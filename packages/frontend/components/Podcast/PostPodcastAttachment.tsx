import { Text, View, type DimensionValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PostPodcastContent } from '@mention/shared-types/post';
import { useReferenceVisibility } from '@/hooks/useReferenceVisibility';
import { useVisibleReference } from '@/hooks/useVisibleReference';
import { syraPodcastCards } from '@/lib/references/syraPodcastCards';
import { PodcastCard } from './PodcastCard';
import { PodcastSaveButton } from './PodcastSaveButton';

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
  const { nativeID, visible } = useReferenceVisibility(postId);
  const state = useVisibleReference(syraPodcastCards, podcast.syraPodcastId, visible);
  const value = state.status === 'ready' ? state.value : undefined;
  return (
    <View
      nativeID={nativeID}
      testID="syra-podcast-card"
      style={{ width, height }}
      className="rounded-2xl overflow-hidden"
    >
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
        <View className="flex-1 justify-center bg-card p-4">
          <Text accessibilityLiveRegion="polite" className="text-muted-foreground">
            {state.status === 'loading'
              ? t('podcast.loading', { defaultValue: 'Loading Syra podcast…' })
              : t('podcast.unavailable', { defaultValue: 'This Syra podcast is unavailable' })}
          </Text>
        </View>
      )}
    </View>
  );
}
