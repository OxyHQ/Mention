import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkline } from '@oxy.so/bloom/chart-cards/sparkline';
import { useTheme } from '@oxy.so/bloom/theme';
import type { PostUser, TrendRelatedDTO, TrendTopicResponse } from '@mention/shared-types';
import { BaseWidget } from '@/components/widgets/BaseWidget';
import { ProfileCard, type ProfileCardData } from '@/components/ProfileCard';
import { useRouter } from '@/lib/navigation/router';
import { trendingService } from '@/services/trendingService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { formatCompactNumber } from '@/utils/formatNumber';
import { Embed, HStack, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';
import {
  Embed as LEmbed,
  VStack as LVStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

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
    color: user.color,
  };
}

/** The people posting most about the topic. Only public, open-audience accounts. */
function TopicPeopleWidget({ authors }: { authors: PostUser[] }) {
  const { t } = useTranslation();
  if (authors.length === 0) return null;
  return (
    <BaseWidget title={t('trend.topic.people', { defaultValue: 'Personas relevantes' })} divider>
      {toElement(
        VStack(
          Embed(
            authors.map((user) => (
              <ProfileCard
                key={user.id}
                profile={toProfileCard(user)}
                size="sm"
                showDivider={false}
              />
            )),
          ),
        ).spacing('sm'),
      )}
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
      {toElement(
        VStack(
          Embed(
            series.length > 1 ? (
              <Sparkline
                data={series}
                width={240}
                height={48}
                shape="sharp"
                color={theme.colors.primary}
              />
            ) : null,
          ),
          HStack(
            Embed(
              <Stat
                value={formatCompactNumber(topic.volume ?? 0)}
                label={t('trend.topic.statPosts', { defaultValue: 'publicaciones' })}
              />,
            ),
            Embed(
              <Stat
                value={formatCompactNumber(topic.authorCount ?? 0)}
                label={t('trend.topic.statPeople', { defaultValue: 'personas' })}
              />,
            ),
            Embed(
              <Stat
                value={`${momentumPercent}%`}
                label={t('trend.topic.statMomentum', { defaultValue: 'ritmo' })}
              />,
            ),
          ).justify('between'),
        ).spacing('md'),
      )}
    </BaseWidget>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return toElement(
    VStack(
      LText(value).font('18').weight('bold').foreground('foreground'),
      LText(label).font('xs').leading('16px').foreground('muted'),
    ).align('start'),
  );
}

/** Trends that co-occur with this one in the batch's graph. */
function TopicRelatedWidget({ related }: { related: TrendRelatedDTO[] }) {
  const { t } = useTranslation();
  const router = useRouter();
  if (related.length === 0) return null;
  return (
    <BaseWidget title={t('trend.topic.related', { defaultValue: 'Relacionados' })} divider>
      {toElement(
        VStack(
          Embed(
            related.map((item) =>
              LtoElement(
                LVStack(
                  LEmbed(
                    toElement(
                      LText(item.displayName ?? item.term)
                        .font('md')
                        .weight('bold')
                        .foreground('foreground')
                        .lines(1),
                    ),
                  ),
                  LEmbed(
                    toElement(
                      LText(
                        t('trend.topic.relatedPosts', {
                          count: item.volume,
                          defaultValue: '{{count}} publicaciones',
                        }),
                      )
                        .font('xs')
                        .leading('16px')
                        .foreground('muted'),
                    ),
                  ),
                )
                  .role('link')
                  .onPress(() => router.push(`/t/${encodeURIComponent(item.term)}`))
                  .pressFade(),
                item.term,
              ),
            ),
          ),
        ).spacing('sm'),
      )}
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
  return toElement(
    VStack(Embed(<TopicWidgetStack term={term} />))
      .padding('horizontal', 'lg')
      .padding('bottom', 'sm'),
  );
}
