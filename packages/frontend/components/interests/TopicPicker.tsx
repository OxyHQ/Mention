import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import {
  useFollowedTopics,
  useTopicFollowTarget,
  type FollowedTopic,
} from '@/hooks/useTopicFollows';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { topicFollowUri } from '@/services/followGraph';
import { topicService } from '@/services/topicService';
import { Button } from '@oxy.so/bloom/button';
import { Muted } from '@oxy.so/bloom/typography';
import type { TopicData } from '@oxy.so/core';
import { resolveFollowPrimaryAction, useAuth, useFollowTarget } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';

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
 * A failed load is an error state with a retry, never an empty catalogue.
 */
export function TopicPicker({ query }: { query: string }) {
  const { t } = useTranslation();
  const { canUsePrivateApi } = useAuth();
  const trimmedQuery = query.trim();

  // Topics whose follow target the server refused. Reported by the chips, so the
  // grid can say why they are inert instead of leaving them silently disabled.
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const markUnavailable = useCallback((slug: string) => {
    setUnavailable((previous) => (previous.has(slug) ? previous : new Set(previous).add(slug)));
  }, []);

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

  // Messages share the chips' inset, so every line of this picker starts on one edge.
  if (catalogue.isError) {
    return (
      <View className="gap-3 px-4 py-4">
        <Muted>{t('settings.interests.loadError')}</Muted>
        <Button
          size="sm"
          appearance="subtle"
          tone="neutral"
          onPress={() => void catalogue.refetch()}
        >
          {t('common.retry')}
        </Button>
      </View>
    );
  }

  if (topics.length === 0) {
    return (
      <View className="px-4 py-4">
        <Muted>
          {trimmedQuery.length > 0
            ? t('settings.interests.noMatches', {
                query: trimmedQuery,
                defaultValue: 'No topics match “{{query}}”.',
              })
            : t('settings.interests.noTopics', {
                defaultValue: 'No topics are available yet.',
              })}
        </Muted>
      </View>
    );
  }

  return (
    <View>
      {canUsePrivateApi ? null : (
        <View className="px-4 pt-4">
          <Muted>{t('settings.interests.signInRequired')}</Muted>
          <Muted>{t('settings.interests.signInRequiredDesc')}</Muted>
        </View>
      )}
      {unavailable.size > 0 ? (
        <View className="px-4 pt-4">
          <Muted>{t('settings.interests.followUnavailable')}</Muted>
        </View>
      ) : null}
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
            onUnavailable={markUnavailable}
          />
        ))}
      </View>
    </View>
  );
}

interface TopicChipProps {
  topic: TopicData;
  seeded: FollowedTopic | undefined;
  followsReady: boolean;
  onUnavailable: (slug: string) => void;
}

/** Binds the shared follow state machine to a Bloom selection control. */
function TopicChip({ topic, seeded, followsReady, onUnavailable }: TopicChipProps) {
  const { t } = useTranslation();

  const { targetId, error } = useTopicFollowTarget({
    slug: topic.slug,
    displayName: topic.displayName,
    ...(topic.icon ? { icon: topic.icon } : {}),
    ...(seeded ? { seededTargetId: seeded.targetId } : {}),
  });

  useEffect(() => {
    if (error) onUnavailable(topic.slug);
  }, [error, onUnavailable, topic.slug]);

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
