import { useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Text } from '@oxy.so/bloom/typography';
import { Sparkline } from '@oxy.so/bloom/chart-cards/sparkline';
import { useTheme } from '@oxy.so/bloom/theme';
import type { PostUser, TrendRelatedDTO, TrendTopicResponse } from '@mention/shared-types';
import { BaseWidget } from '@/components/widgets/BaseWidget';
import { ProfileCard, type ProfileCardData } from '@/components/ProfileCard';
import { useRouter } from '@/lib/navigation/router';
import { trendingService } from '@/services/trendingService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { formatCompactNumber } from '@/utils/formatNumber';

/** The topic's live numbers, shared by every widget below. */
function useTopic(term: string) {
  return useQuery({
    queryKey: publicQueryKeys.trendTopic(term),
    queryFn: () => trendingService.getTrendTopic(term),
    enabled: term.length > 0,
    staleTime: 60_000,
  });
}

function toProfileCard(user: PostUser): ProfileCardData {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
    verified: user.verified,
    isFederated: user.isFederated,
    kind: user.kind,
    character: user.character,
  };
}

/** The people posting most about the topic. Only public, open-audience accounts. */
function TopicPeopleWidget({ authors }: { authors: PostUser[] }) {
  const { t } = useTranslation();
  if (authors.length === 0) return null;
  return (
    <BaseWidget title={t('trend.topic.people', { defaultValue: 'Personas relevantes' })} divider>
      <View className="gap-2">
        {authors.map((user) => (
          <ProfileCard
            key={user.id}
            profile={toProfileCard(user)}
            size="sm"
            showDivider={false}
            horizontalInset={0}
          />
        ))}
      </View>
    </BaseWidget>
  );
}

/** How the topic is moving: its curve over the window, and three honest counts. */
function TopicMovementWidget({ topic }: { topic: TrendTopicResponse }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const series = topic.series ?? [];
  const momentumPercent = Math.round((topic.momentum ?? 0) * 100);

  return (
    <BaseWidget title={t('trend.topic.movement', { defaultValue: 'Cómo se mueve' })} divider>
      <View className="gap-3">
        {series.length > 1 ? (
          <Sparkline
            data={series}
            width={240}
            height={48}
            shape="sharp"
            color={theme.colors.primary}
          />
        ) : null}
        <View className="flex-row justify-between">
          <Stat
            value={formatCompactNumber(topic.volume ?? 0)}
            label={t('trend.topic.statPosts', { defaultValue: 'publicaciones' })}
          />
          <Stat
            value={formatCompactNumber(topic.authorCount ?? 0)}
            label={t('trend.topic.statPeople', { defaultValue: 'personas' })}
          />
          <Stat
            value={`${momentumPercent}%`}
            label={t('trend.topic.statMomentum', { defaultValue: 'ritmo' })}
          />
        </View>
      </View>
    </BaseWidget>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View className="items-start">
      <Text className="text-[18px] font-bold text-foreground">{value}</Text>
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}

/** Trends that co-occur with this one in the batch's graph. */
function TopicRelatedWidget({ related }: { related: TrendRelatedDTO[] }) {
  const { t } = useTranslation();
  const router = useRouter();
  if (related.length === 0) return null;
  return (
    <BaseWidget title={t('trend.topic.related', { defaultValue: 'Relacionados' })} divider>
      <View className="gap-2">
        {related.map((item) => (
          <TouchableOpacity
            key={item.term}
            accessibilityRole="link"
            onPress={() => router.push(`/t/${encodeURIComponent(item.term)}`)}
          >
            <Text className="text-[15px] font-bold text-foreground" numberOfLines={1}>
              {item.displayName ?? item.term}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t('trend.topic.relatedPosts', {
                count: item.volume,
                defaultValue: '{{count}} publicaciones',
              })}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </BaseWidget>
  );
}

/**
 * The topic's widgets, stacked. Renders nothing for a term that is not in the
 * current batch, and each widget renders nothing when it has nothing to say.
 */
function TopicWidgetStack({ term }: { term: string }) {
  const { data } = useTopic(term);
  const topic = data;
  const hasLiveTopic = Boolean(topic?.updatedAt);

  const authors = useMemo(() => topic?.topAuthors ?? [], [topic]);
  const related = useMemo(() => topic?.related ?? [], [topic]);

  if (!topic || !hasLiveTopic) return null;
  return (
    <>
      <TopicPeopleWidget authors={authors} />
      <TopicMovementWidget topic={topic} />
      <TopicRelatedWidget related={related} />
    </>
  );
}

/** Right rail, above the shared widgets, on web. */
export function TopicRailWidgets({ term }: { term: string }) {
  return <TopicWidgetStack term={term} />;
}

/** Stacked under the header, on native where there is no rail. */
export function TopicInlineWidgets({ term }: { term: string }) {
  return (
    <View className="px-4 pb-2">
      <TopicWidgetStack term={term} />
    </View>
  );
}
