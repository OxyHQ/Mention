import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TrendGraphEdgeDTO, TrendGraphNodeDTO } from '@mention/shared-types';

import { trendingService } from '@/services/trendingService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { layoutGraph } from '@/utils/forceLayout';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';

/**
 * Explore › Trend relations (route `/explore/trending-graph`).
 *
 * The list answers what is trending. This answers why it looks the way it does:
 * which terms share posts, which of them the detector merged into one story,
 * and — the interesting ones — which pairs are related and were NOT merged.
 *
 * It is a GRAPH and deliberately not an org chart. Co-occurrence is symmetric:
 * it can say `Kyiv` and `Ukraine` belong together, never that one is a kind of
 * the other. Drawing a hierarchy would be inventing a direction the measurement
 * does not contain, so the picture shows what the data is — nodes, weighted
 * links, and clusters.
 */

/** The graph is a small, slow-moving artefact; the batch behind it runs every 30 minutes. */
const GRAPH_STALE_TIME_MS = 5 * 60_000;

/** Drawing box. Height is capped so the graph never pushes its own legend off-screen. */
const MIN_CANVAS = 280;
const MAX_CANVAS = 560;

/** Node radius range, in points. */
const MIN_RADIUS = 6;
const MAX_RADIUS = 22;

/**
 * A stable hue per story, so the same cluster keeps its colour across renders
 * and across filters. Derived from the story's own key rather than its position
 * in the list, which changes whenever a filter changes.
 */
function hueFor(story: string): number {
  let hash = 0;
  for (let index = 0; index < story.length; index++) {
    hash = (hash * 31 + story.charCodeAt(index)) % 360;
  }
  return hash;
}

export default function TrendingGraphScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { navigateToTerm } = useTrendNavigation();

  const [language, setLanguage] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: publicQueryKeys.trendGraph(language, region),
    queryFn: () =>
      trendingService.getTrendGraph({
        ...(language ? { language } : {}),
        ...(region ? { region } : {}),
      }),
    staleTime: GRAPH_STALE_TIME_MS,
  });

  const size = Math.max(MIN_CANVAS, Math.min(MAX_CANVAS, width - 32));

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);

  const maxVolume = useMemo(
    () => nodes.reduce((highest, node) => Math.max(highest, node.volume), 1),
    [nodes],
  );
  const maxPosts = useMemo(
    () => edges.reduce((highest, edge) => Math.max(highest, edge.posts), 1),
    [edges],
  );

  const positions = useMemo(() => {
    const placed = layoutGraph(
      nodes.map((node) => ({ id: node.term, weight: node.volume / maxVolume })),
      edges.map((edge) => ({
        source: edge.a,
        target: edge.b,
        strength: edge.posts / maxPosts,
      })),
    );
    return new Map(placed.map((position) => [position.id, position]));
  }, [nodes, edges, maxVolume, maxPosts]);

  // Inset by the largest radius so a big node on the boundary is never clipped.
  const toPoint = useCallback(
    (term: string) => {
      const position = positions.get(term);
      if (!position) return null;
      const inset = MAX_RADIUS + 2;
      const span = size - inset * 2;
      return { x: inset + position.x * span, y: inset + position.y * span };
    },
    [positions, size],
  );

  const radiusFor = useCallback(
    (node: TrendGraphNodeDTO) =>
      MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(node.volume / maxVolume),
    [maxVolume],
  );

  const colorFor = useCallback(
    (node: TrendGraphNodeDTO) =>
      node.story ? `hsl(${hueFor(node.story)}, 62%, 55%)` : theme.colors.textSecondary,
    [theme.colors.textSecondary],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.term === selected) ?? null,
    [nodes, selected],
  );
  const selectedEdges = useMemo(
    () => (selected ? edges.filter((edge) => edge.a === selected || edge.b === selected) : []),
    [edges, selected],
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

  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4 gap-4">
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
        Region is rendered only when the data has any. `postClassification.region`
        is sparse, and an always-visible filter with nothing in it would read as
        a broken control rather than as an absent signal.
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

      {nodes.length === 0 ? (
        <Text className="py-8 text-center text-muted-foreground">{t('trendGraph.empty')}</Text>
      ) : (
        <View className="items-center">
          <Svg width={size} height={size}>
            {edges.map((edge) => {
              const from = toPoint(edge.a);
              const to = toPoint(edge.b);
              if (!from || !to) return null;
              const involvesSelection = selected === edge.a || selected === edge.b;
              return (
                <Line
                  key={`${edge.a}|${edge.b}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={theme.colors.textSecondary}
                  strokeWidth={1 + 3 * (edge.posts / maxPosts)}
                  // A merged pair is drawn solid and a near miss dashed, so the
                  // question the graph exists to answer is visible without
                  // pressing anything.
                  strokeDasharray={edge.linked ? undefined : '4 4'}
                  opacity={selected && !involvesSelection ? 0.12 : edge.linked ? 0.55 : 0.3}
                />
              );
            })}
            {nodes.map((node) => {
              const point = toPoint(node.term);
              if (!point) return null;
              const isSelected = node.term === selected;
              return (
                <React.Fragment key={node.term}>
                  <Circle
                    cx={point.x}
                    cy={point.y}
                    r={radiusFor(node)}
                    fill={colorFor(node)}
                    stroke={isSelected ? theme.colors.text : 'transparent'}
                    strokeWidth={isSelected ? 2 : 0}
                    opacity={selected && !isSelected ? 0.45 : 1}
                    onPress={() => setSelected(isSelected ? null : node.term)}
                  />
                  <SvgText
                    x={point.x}
                    y={point.y + radiusFor(node) + 11}
                    fontSize={10}
                    textAnchor="middle"
                    fill={theme.colors.text}
                    opacity={selected && !isSelected ? 0.4 : 0.9}
                    onPress={() => setSelected(isSelected ? null : node.term)}
                  >
                    {node.displayName ?? node.term}
                  </SvgText>
                </React.Fragment>
              );
            })}
          </Svg>
        </View>
      )}

      <View className="gap-1">
        <Text className="text-xs text-muted-foreground">{t('trendGraph.legend.solid')}</Text>
        <Text className="text-xs text-muted-foreground">{t('trendGraph.legend.dashed')}</Text>
        <Text className="text-xs text-muted-foreground">{t('trendGraph.legend.size')}</Text>
        {data?.droppedEdges ? (
          <Text className="text-xs text-muted-foreground">
            {t('trendGraph.legend.truncated', { count: data.droppedEdges })}
          </Text>
        ) : null}
      </View>

      {selectedNode ? (
        <View className="gap-2 rounded-2xl bg-muted p-4">
          <Pressable accessibilityRole="button" onPress={() => navigateToTerm(selectedNode.term, 'graph')}>
            <Text className="text-lg font-semibold text-foreground">
              {selectedNode.displayName ?? selectedNode.term}
            </Text>
          </Pressable>
          <Text className="text-sm text-muted-foreground">
            {t('trendGraph.node.counts', {
              posts: selectedNode.volume,
              authors: selectedNode.authorCount,
            })}
          </Text>
          {selectedNode.languages.length > 0 ? (
            <Text className="text-sm text-muted-foreground">
              {t('trendGraph.node.languages', { list: selectedNode.languages.join(', ') })}
            </Text>
          ) : null}
          {selectedNode.regions.length > 0 ? (
            <Text className="text-sm text-muted-foreground">
              {t('trendGraph.node.regions', { list: selectedNode.regions.join(', ') })}
            </Text>
          ) : null}
          {selectedNode.story ? (
            <Text className="text-sm text-muted-foreground">
              {t('trendGraph.node.story', { story: selectedNode.story })}
            </Text>
          ) : null}
          {selectedEdges.map((edge) => (
            <EdgeRow key={`${edge.a}|${edge.b}`} edge={edge} term={selectedNode.term} />
          ))}
        </View>
      ) : null}
    </ScrollView>
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

/** One relation of the selected term, said in words rather than only drawn. */
function EdgeRow({ edge, term }: { edge: TrendGraphEdgeDTO; term: string }) {
  const { t } = useTranslation();
  const other = edge.a === term ? edge.b : edge.a;

  return (
    <Text className="text-sm text-foreground">
      {t(edge.linked ? 'trendGraph.edge.merged' : 'trendGraph.edge.related', {
        term: other,
        posts: edge.posts,
      })}
    </Text>
  );
}
