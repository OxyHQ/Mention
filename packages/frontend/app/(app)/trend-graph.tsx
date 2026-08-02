import React, { useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useSafeBack } from '@/hooks/useSafeBack';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { SEO } from '@/components/SEO';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import { trendingService } from '@/services/trendingService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { buildTrendTree, type TrendTreeNode, type TrendTreeRelation } from '@/utils/trendGraphTree';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';

/**
 * Trend relations (route `/trend-graph`).
 *
 * The list answers what is trending. This answers why it looks that way: which
 * terms the detector merged into one story, and which pairs share posts and
 * were NOT merged.
 *
 * It lives at the top level rather than under `explore/` because it is a DETAIL
 * screen, not a tab. The explore layout imposes the "Explore" title and a
 * five-tab bar that this route matches none of, so nesting it there framed a
 * detail view in a tab shell — with a header naming something else and a tab
 * strip where nothing was selected. Here it gets what every other detail screen
 * has: its own title and a way back.
 *
 * Drawn as an indented tree rather than a scatter of nodes. Co-occurrence alone
 * is symmetric and could not justify a hierarchy, but clustering produces a
 * representative per story — "the row this term is reported under" — and that
 * relation is genuinely directed. The rows follow `TrendItemRow`'s anatomy
 * (hairline separators, label above name, no cards) so the screen reads as part
 * of the app rather than as a diagram dropped into it.
 */

/** The graph is a slow-moving artefact — the batch behind it runs every 30 minutes. */
const GRAPH_STALE_TIME_MS = 5 * 60_000;

export default function TrendGraphScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();

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

  const tree = useMemo(() => buildTrendTree(data?.nodes ?? [], data?.edges ?? []), [data]);
  const isEmpty = tree.stories.length === 0 && tree.ungrouped.length === 0;

  return (
    <SafeAreaView className="flex-1" edges={['top']}>
      <SEO title={t('seo.trendGraph.title')} description={t('seo.trendGraph.description')} />
      <PanelStickyHeader level={0}>
        <Header
          options={{
            title: t('trendGraph.title'),
            leftComponents: [
              <IconButton key="back" variant="icon" onPress={safeBack}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          disableSticky
        />
      </PanelStickyHeader>

      <ScrollView className="flex-1" contentContainerClassName="pb-16">
        <View className="px-4 pb-3">
          <ThemedText className="mb-1 font-primary text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('trendGraph.eyebrow')}
          </ThemedText>
          <ThemedText type="title" className="mb-1 font-primary text-[28px] font-bold">
            {t('trendGraph.title')}
          </ThemedText>
          <ThemedText className="font-primary text-sm text-muted-foreground">
            {t('trendGraph.subtitle')}
          </ThemedText>
        </View>

        <FilterRow
          values={data?.availableLanguages ?? []}
          selected={language}
          onSelect={setLanguage}
          allLabel={t('trendGraph.filters.all')}
        />
        {/*
          Region renders only when the data has any. `postClassification.region`
          is sparse, and an always-present filter with nothing in it reads as a
          broken control rather than as an absent signal.
        */}
        {(data?.availableRegions.length ?? 0) > 0 && (
          <FilterRow
            values={data?.availableRegions ?? []}
            selected={region}
            onSelect={setRegion}
            allLabel={t('trendGraph.filters.all')}
          />
        )}

        {isLoading ? (
          <View className="items-center py-10">
            <SpinnerIcon size={20} className="text-primary" />
          </View>
        ) : isError ? (
          // An unreachable graph must not render as an empty one: "no relations
          // found" over an outage would say the network has no stories.
          <View className="items-center gap-3 px-4 py-10">
            <ThemedText className="text-center font-primary text-sm text-muted-foreground">
              {t('trendGraph.error')}
            </ThemedText>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => void refetch()}
              className="rounded-full bg-primary px-4 py-2"
              style={styles.webCursor}
            >
              <ThemedText className="font-primary text-sm font-semibold text-primary-foreground">
                {t('trendGraph.retry')}
              </ThemedText>
            </TouchableOpacity>
          </View>
        ) : isEmpty ? (
          <ThemedText className="px-4 py-10 text-center font-primary text-sm text-muted-foreground">
            {t('trendGraph.empty')}
          </ThemedText>
        ) : (
          <>
            {tree.stories.length > 0 ? (
              <Section title={t('trendGraph.sections.stories')}>
                {tree.stories.map((story) => (
                  <Branch key={story.node.term} entry={story} />
                ))}
              </Section>
            ) : null}

            {tree.ungrouped.length > 0 ? (
              <Section title={t('trendGraph.sections.ungrouped')}>
                {tree.ungrouped.map((entry) => (
                  <Branch key={entry.node.term} entry={entry} />
                ))}
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A titled block of rows, matching the section headers used across the app. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-2">
      <View className="bg-background px-4 py-2">
        <ThemedText className="font-primary text-sm font-medium text-muted-foreground">
          {title}
        </ThemedText>
      </View>
      <View className="px-4">{children}</View>
    </View>
  );
}

/** A root term, the terms merged into it, and the near misses of each. */
function Branch({ entry }: { entry: TrendTreeNode }) {
  const { t } = useTranslation();

  return (
    <View className="border-border" style={styles.branchBorder}>
      <TermRow
        term={entry.node.term}
        label={entry.node.displayName ?? entry.node.term}
        caption={t('trendGraph.node.counts', {
          posts: entry.node.volume,
          authors: entry.node.authorCount,
        })}
        badge={
          entry.children.length > 0
            ? t('trendGraph.badge.merged', { count: entry.children.length })
            : undefined
        }
        emphasis
      />

      {entry.children.length > 0 ? (
        <View className="border-border pl-3" style={styles.trunk}>
          {entry.children.map((child) => (
            <View key={child.node.term}>
              <TermRow
                term={child.node.term}
                label={child.node.displayName ?? child.node.term}
                caption={t('trendGraph.node.counts', {
                  posts: child.node.volume,
                  authors: child.node.authorCount,
                })}
              />
              <RelationList relations={child.related} />
            </View>
          ))}
        </View>
      ) : null}

      <RelationList relations={entry.related} />
    </View>
  );
}

/** The near misses of one term — related, and deliberately not merged. */
function RelationList({ relations }: { relations: TrendTreeRelation[] }) {
  const { t } = useTranslation();
  const { navigateToTerm } = useTrendNavigation();

  if (relations.length === 0) return null;

  return (
    <View className="border-border pb-1 pl-3" style={styles.dashedTrunk}>
      {relations.map((relation) => (
        <TouchableOpacity
          key={relation.term}
          accessibilityRole="button"
          activeOpacity={0.7}
          onPress={() => navigateToTerm(relation.term, 'graph')}
          className="flex-row items-center py-1"
          style={styles.webCursor}
        >
          <ThemedText className="shrink font-primary text-[12px] text-muted-foreground">
            {t('trendGraph.edge.related', {
              term: relation.displayName ?? relation.term,
              posts: relation.posts,
            })}
          </ThemedText>
        </TouchableOpacity>
      ))}
    </View>
  );
}

/**
 * One term, laid out like a trend row: the measurement above in muted small
 * type, the name below in bold. Same anatomy as `TrendItemRow`, so the two
 * screens read as one app.
 */
function TermRow({
  term,
  label,
  caption,
  badge,
  emphasis = false,
}: {
  term: string;
  label: string;
  caption: string;
  badge?: string;
  emphasis?: boolean;
}) {
  const { navigateToTerm } = useTrendNavigation();

  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.7}
      onPress={() => navigateToTerm(term, 'graph')}
      className="flex-row items-center justify-between border-border py-3"
      style={[styles.webCursor, styles.rowBorder]}
    >
      <View className="mr-3 flex-1">
        <View className="mb-0.5 flex-row items-center">
          <ThemedText className="font-primary text-[12px] text-muted-foreground">
            {caption}
          </ThemedText>
          {badge ? (
            <View className="ml-2 rounded-full bg-primary/10 px-1.5 py-0.5">
              <ThemedText className="font-primary text-[11px] font-semibold text-primary">
                {badge}
              </ThemedText>
            </View>
          ) : null}
        </View>
        <ThemedText
          className={`font-primary text-foreground ${emphasis ? 'text-[16px] font-bold' : 'text-[14px] font-semibold'}`}
          numberOfLines={2}
        >
          {label}
        </ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={14} className="text-muted-foreground" />
    </TouchableOpacity>
  );
}

/** One axis of scoping, rendered from the values the data actually holds. */
function FilterRow({
  values,
  selected,
  onSelect,
  allLabel,
}: {
  values: string[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  allLabel: string;
}) {
  if (values.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-4 pb-3"
    >
      {[null, ...values].map((value) => {
        const isActive = value === selected;
        return (
          <TouchableOpacity
            key={value ?? '__all'}
            accessibilityRole="button"
            activeOpacity={0.7}
            onPress={() => onSelect(value)}
            className={`rounded-full px-3 py-1.5 ${isActive ? 'bg-primary' : 'bg-muted'}`}
            style={styles.webCursor}
          >
            <ThemedText
              className={`font-primary text-[13px] font-medium ${isActive ? 'text-primary-foreground' : 'text-foreground'}`}
            >
              {value ?? allLabel}
            </ThemedText>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  // Hairline separators, the same weight `TrendItemRow` uses — the app draws
  // lists with rules, not with cards.
  rowBorder: { borderBottomWidth: 0.5 },
  branchBorder: { borderBottomWidth: 0.5 },
  // The trunk a branch hangs from. Solid for merged terms, dashed for the ones
  // that were related and not merged, which is the distinction the screen exists
  // to show.
  trunk: { borderLeftWidth: 1 },
  dashedTrunk: { borderLeftWidth: 1, borderStyle: 'dashed' },
});
