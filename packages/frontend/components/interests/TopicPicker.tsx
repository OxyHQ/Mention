import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import {
  useFollowedTopics,
  useTopicFollowTargetId,
  type FollowedTopic,
} from '@/hooks/useTopicFollows';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { topicFollowUri } from '@/services/followGraph';
import { topicService } from '@/services/topicService';
import { Button } from '@oxy.so/bloom/button';
import type { TopicData } from '@oxy.so/core';
import { resolveFollowPrimaryAction, useFollowTarget } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

/**
 * The topic grid where selecting a chip FOLLOWS the topic in the user-owned
 * follow graph every Oxy application shares. Settings (`Your interests`) and the
 * first-run `/welcome` flow both render this one component.
 *
 * An empty `query` shows the curated categories; a query searches the
 * catalogue. ONE query key covers both, because they answer the same question —
 * what should the grid show — and a second key would let the two disagree about
 * which is on screen.
 *
 * Not gated on the viewer: `/topics` is mounted on the public API and the
 * catalogue is the same for everyone. Only the FOLLOW state is viewer-scoped.
 * Both service calls resolve to an empty list rather than throwing, so the grid
 * always settles.
 */
export function TopicPicker({ query }: { query: string }) {
  const { t } = useTranslation();
  const trimmedQuery = query.trim();

  const catalogue = useQuery({
    queryKey: publicQueryKeys.topicCatalogue(trimmedQuery),
    queryFn: () =>
      trimmedQuery.length > 0
        ? topicService.search(trimmedQuery, 40)
        : topicService.getCategories(),
    staleTime: 5 * 60 * 1000,
  });

  const followed = useFollowedTopics();
  const topics = useMemo(() => catalogue.data ?? [], [catalogue.data]);

  if (catalogue.isLoading) return <SettingsSkeleton />;

  if (topics.length === 0) {
    return (
      <View className="px-4 py-6">
        <Text className="text-[13px] text-muted-foreground">
          {trimmedQuery.length > 0
            ? t('settings.interests.noMatches', {
                query: trimmedQuery,
                defaultValue: 'No topics match “{{query}}”.',
              })
            : t('settings.interests.noTopics', {
                defaultValue: 'No topics are available yet.',
              })}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-row flex-wrap gap-2 px-4 py-4">
      {topics.map((topic) => (
        <TopicChip
          key={topic.slug}
          topic={topic}
          seeded={followed.byUri.get(topicFollowUri(topic.slug))}
          // Until the sweep lands, a chip cannot tell "not followed" from "not
          // asked yet", and offering to follow something already followed is
          // the one mistake this grid must not make.
          followsReady={followed.isReady}
        />
      ))}
    </View>
  );
}

interface TopicChipProps {
  topic: TopicData;
  seeded: FollowedTopic | undefined;
  followsReady: boolean;
}

/** Binds the shared follow state machine to a Bloom selection control. */
function TopicChip({ topic, seeded, followsReady }: TopicChipProps) {
  const { t } = useTranslation();

  const targetId = useTopicFollowTargetId({
    slug: topic.slug,
    displayName: topic.displayName,
    ...(topic.icon ? { icon: topic.icon } : {}),
    ...(seeded ? { seededTargetId: seeded.targetId } : {}),
  });

  const follow = useFollowTarget(targetId, seeded ? { initialStatus: seeded.status } : undefined);

  const isOffHere = follow.isFollowing && follow.status.applicationMode === 'disabled';

  /*
   * The SDK decides WHAT a press means; this only routes its answer to the
   * matching mutation. The middle case is the one worth naming: a follow the
   * viewer switched OFF in Mention still reads as followed globally, so a
   * press turns it back on HERE rather than unfollowing it everywhere and
   * throwing away a relationship they still hold in every other Oxy app.
   *
   * The `never` arm is what keeps this honest as that rule grows: a new action
   * upstream becomes a type error here instead of a press that silently does
   * nothing.
   */
  const onPress = useCallback(() => {
    const action = resolveFollowPrimaryAction({
      isFollowing: follow.isFollowing,
      applicationMode: follow.status.applicationMode,
    });
    switch (action) {
      case 'follow':
        void follow.follow();
        return;
      case 'enable-here':
        void follow.enableHere();
        return;
      case 'unfollow':
        void follow.unfollow();
        return;
      default: {
        const unhandled: never = action;
        throw new Error(`Unhandled follow action: ${String(unhandled)}`);
      }
    }
  }, [follow]);

  /*
   * Inert until BOTH the sweep has settled and a target exists. Pressing
   * earlier would either act on a relationship whose state is not yet known or
   * address a row that does not exist yet.
   */
  const disabled = !followsReady || !targetId || follow.isPending;

  const label = topic.displayName || topic.slug;

  return (
    <Button
      size="sm"
      appearance={follow.isFollowing && !isOffHere ? 'solid' : 'subtle'}
      tone="neutral"
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={
        isOffHere
          ? t('settings.interests.chipOffHere', {
              topic: label,
              defaultValue: 'Show {{topic}} in Mention again',
            })
          : follow.isFollowing
            ? t('settings.interests.chipUnfollow', {
                topic: label,
                defaultValue: 'Unfollow {{topic}}',
              })
            : t('settings.interests.chipFollow', {
                topic: label,
                defaultValue: 'Follow {{topic}}',
              })
      }
      aria-pressed={follow.isFollowing && !isOffHere}
    >
      {label}
    </Button>
  );
}
