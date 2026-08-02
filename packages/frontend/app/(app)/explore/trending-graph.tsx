import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { trendingService } from '@/services/trendingService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { buildTrendTree, type TrendTreeNode } from '@/utils/trendGraphTree';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';

/**
 * Explore › Trend relations (route `/explore/trending-graph`).
 *
 * The list answers what is trending. This answers why it looks that way: which
 * terms the detector merged into one story, and which pairs share posts and
 * were NOT merged.
 *
 * Rendered as an indented TREE rather than a scatter of nodes, because the
 * relation being drawn is genuinely directed. Co-occurrence itself is symmetric
 * and could not justify a hierarchy — but clustering produces a representative
 * per story, and "the row this term is reported under" is a real parent. The
 * shape claims exactly that and nothing more.
 *
 * Plain views and borders, no canvas: the tree reflows at any width, wraps its
 * labels, and scrolls with the page, which a fixed-size drawing cannot.
 */

/** The graph is a slow-moving artefact — the batch behind it runs every 30 minutes. */
const GRAPH_STALE_TIME_MS = 5 * 60_000;

export default function TrendingGraphScreen() {
  const { t } = useTranslation();

  const [language, setLanguage] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: publicQueryKeys.trendGraph(language, region),
    queryFn: () =>
      trendingService.getTrendGraph({
        ...(language ? { language } : {}),
        ...(region ? { region } : {}),
      }),
    staleTime: GRAPH_STALE_TIME_MS,
  });

  const tree = useMemo(
    () => buildTrendTree(data?.nodes ?? [], data?.edges ?? []),
    [data],
  );

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <SpinnerIcon />
      </View>
    );
  }

  // An unreachable graph must not render as an empty one: "no relations found"
  // over an outage would tell a reader the network has no stories.
  if (isError) {
    return (
      <View className="flex-1 items-center justify-center gap-3 p-6">
        <Text className="text-center text-base text-foreground">{t('trendGraph.error')}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void refetch()}
          className="rounded-full bg-primary px-4 py-2"
        >
          <Text className="text-primary-foreground">{t('trendGraph.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  const isEmpty = tree.stories.length === 0 && tree.ungrouped.length === 0;

  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4 gap-5 pb-16">
      <View className="gap-1">
        <Text className="text-2xl font-bold text-foreground">{t('trendGraph.title')}</Text>
        <Text className="text-sm text-muted-foreground">{t('trendGraph.subtitle')}</Text>
      </View>

      <FilterRow
        label={t('trendGraph.filters.language')}
        allLabel={t('trendGraph.filters.all')}
        values={data?.availableLanguages ?? []}
        selected={language}
        onSelect={setLanguage}
      />
      {/*
        Region renders only when the data has any. `postClassification.region` is
        sparse, and an always-present filter with nothing in it reads as a broken
        control rather than as an absent signal.
      */}
      {(data?.availableRegions.length ?? 0) > 0 && (
        <FilterRow
          label={t('trendGraph.filters.region')}
          allLabel={t('trendGraph.filters.all')}
          values={data?.availableRegions ?? []}
          selected={region}
          onSelect={setRegion}
        />
      )}

      {isEmpty ? (
        <Text className="py-8 text-center text-muted-foreground">{t('trendGraph.empty')}</Text>
      ) : (
        <>
          {tree.stories.length > 0 && (
            <View className="gap-3">
              <Text className="text-xs uppercase text-muted-foreground">
                {t('trendGraph.sections.stories')}
              </Text>
              {tree.stories.map((story) => (
                <TreeBranch key={story.node.term} entry={story} isStory />
              ))}
            </View>
          )}

          {tree.ungrouped.length > 0 && (
            <View className="gap-3">
              <Text className="text-xs uppercase text-muted-foreground">
                {t('trendGraph.sections.ungrouped')}
              </Text>
              {tree.ungrouped.map((entry) => (
                <TreeBranch key={entry.node.term} entry={entry} isStory={false} />
              ))}
            </View>
          )}
        </>
      )}

      <View className="gap-1 border-t border-border pt-3">
        <Text className="text-xs text-muted-foreground">{t('trendGraph.legend.branch')}</Text>
        <Text className="text-xs text-muted-foreground">{t('trendGraph.legend.related')}</Text>
        {data?.droppedEdges ? (
          <Text className="text-xs text-muted-foreground">
            {t('trendGraph.legend.truncated', { count: data.droppedEdges })}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

/**
 * One root and everything under it.
 *
 * The connector is a left border on the children's container plus a short
 * horizontal rule per row — the two together read as the elbow of a tree at any
 * width, and neither needs a measured position, so the whole branch reflows and
 * wraps like ordinary text.
 */
function TreeBranch({ entry, isStory }: { entry: TrendTreeNode; isStory: boolean }) {
  const { t } = useTranslation();
  const { navigateToTerm } = useTrendNavigation();

  return (
    <View className="rounded-2xl bg-muted p-3">
      <Pressable
        accessibilityRole="button"
        onPress={() => navigateToTerm(entry.node.term, 'graph')}
        className="gap-0.5"
      >
        <Text className="text-base font-semibold text-foreground">
          {entry.node.displayName ?? entry.node.term}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t('trendGraph.node.counts', {
            posts: entry.node.volume,
            authors: entry.node.authorCount,
          })}
          {entry.node.languages.length > 0 ? ` · ${entry.node.languages.join(', ')}` : ''}
          {entry.node.regions.length > 0 ? ` · ${entry.node.regions.join(', ')}` : ''}
        </Text>
      </Pressable>

      {isStory && entry.children.length > 0 ? (
        <View className="mt-2 border-l border-border pl-3">
          {entry.children.map((child) => (
            <TreeRow
              key={child.node.term}
              term={child.node.term}
              label={child.node.displayName ?? child.node.term}
              detail={t('trendGraph.node.counts', {
                posts: child.node.volume,
                authors: child.node.authorCount,
              })}
              related={child.related}
            />
          ))}
        </View>
      ) : null}

      {entry.related.length > 0 ? (
        <View className="mt-2 border-l border-dashed border-border pl-3">
          {entry.related.map((relation) => (
            <RelatedRow key={relation.term} term={relation.term} posts={relation.posts} label={relation.displayName} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A merged term, with its own near misses beneath it. */
function TreeRow({
  term,
  label,
  detail,
  related,
}: {
  term: string;
  label: string;
  detail: string;
  related: TrendTreeNode['related'];
}) {
  const { navigateToTerm } = useTrendNavigation();

  return (
    <View className="py-1">
      <Pressable
        accessibilityRole="button"
        onPress={() => navigateToTerm(term, 'graph')}
        className="flex-row items-center gap-2"
      >
        <View className="h-px w-3 bg-border" />
        <Text className="shrink text-sm text-foreground">{label}</Text>
        <Text className="shrink-0 text-xs text-muted-foreground">{detail}</Text>
      </Pressable>
      {related.length > 0 ? (
        <View className="ml-3 border-l border-dashed border-border pl-3">
          {related.map((relation) => (
            <RelatedRow key={relation.term} term={relation.term} posts={relation.posts} label={relation.displayName} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A term that shares posts with its parent and was NOT merged into it. */
function RelatedRow({ term, posts, label }: { term: string; posts: number; label?: string }) {
  const { t } = useTranslation();
  const { navigateToTerm } = useTrendNavigation();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigateToTerm(term, 'graph')}
      className="flex-row items-center gap-2 py-0.5"
    >
      <View className="h-px w-3 bg-border opacity-60" />
      <Text className="shrink text-xs text-muted-foreground">
        {t('trendGraph.edge.related', { term: label ?? term, posts })}
      </Text>
    </Pressable>
  );
}

/** One axis of scoping, rendered from the values the data actually holds. */
function FilterRow({
  label,
  allLabel,
  values,
  selected,
  onSelect,
}: {
  label: string;
  allLabel: string;
  values: string[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  if (values.length === 0) return null;

  return (
    <View className="gap-2">
      <Text className="text-xs uppercase text-muted-foreground">{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
        {[null, ...values].map((value) => {
          const isActive = value === selected;
          return (
            <Pressable
              key={value ?? '__all'}
              accessibilityRole="button"
              onPress={() => onSelect(value)}
              className={`rounded-full px-3 py-1 ${isActive ? 'bg-primary' : 'bg-muted'}`}
            >
              <Text className={isActive ? 'text-primary-foreground' : 'text-foreground'}>
                {value ?? allLabel}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
