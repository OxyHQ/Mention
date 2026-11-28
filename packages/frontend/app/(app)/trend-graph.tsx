import { InsightsSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Text } from '@oxy.so/bloom/typography';

import { SEO } from '@/components/SEO';
import { trendingService } from '@/services/trendingService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { buildTrendTree, type TrendTreeNode } from '@/utils/trendGraphTree';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';
import { EmptyState } from '@/components/common/EmptyState';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const useTextStyles = createTokenStyles((t) => ({
  label: { lineHeight: 24, marginRight: 12, flexShrink: 1 },
  labelEmphasis: { fontSize: 15, fontWeight: '700' },
  labelPlain: { fontSize: 14 },
  filter: { fontSize: 13, lineHeight: 24, fontWeight: '500' },
  filterActive: { color: t.primaryForeground },
  subtitle: {
    fontSize: 13,
    lineHeight: 24,
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 4,
    color: t.mutedForeground,
  },
  errorText: { fontSize: 14, lineHeight: 24, textAlign: 'center', color: t.mutedForeground },
  retry: { fontSize: 14, lineHeight: 24, fontWeight: '600', color: t.primaryForeground },
  sectionTitle: { fontSize: 14, lineHeight: 24, fontWeight: '500', color: t.mutedForeground },
  related: { fontSize: 12, lineHeight: 24, color: t.mutedForeground },
  counts: { fontSize: 12, lineHeight: 24, flexShrink: 0, color: t.mutedForeground },
}));

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
  const textStyles = useTextStyles();
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

  const tree = useMemo(() => buildTrendTree(data?.nodes ?? [], data?.edges ?? []), [data]);
  const isEmpty = tree.stories.length === 0 && tree.ungrouped.length === 0;

  return (
    <>
      <SEO
        title={t('seo.trendGraph.title')}
        description={t('seo.trendGraph.description')}
        robots="index,follow"
      />
      <Screen
        header={
          <PageHeader
            title={t('trendGraph.title')}
            backLabel={t('common.back', { defaultValue: 'Back' })}
          />
        }
      >
        <ScreenScrollView contentView contentContainerStyle={{ paddingBottom: 64 }}>
          {/*
          No title block here. The header above already names the screen, and
          repeating it in 28px — under an uppercase eyebrow — spent the first
          fifth of the viewport saying the same thing three times.
        */}
          <Text style={textStyles.subtitle}>{t('trendGraph.subtitle')}</Text>

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
            <InsightsSkeleton />
          ) : isError ? (
            // An unreachable graph must not render as an empty one: "no relations
            // found" over an outage would say the network has no stories.
            <View className="items-center gap-3 px-4 py-10">
              <Text style={textStyles.errorText}>{t('trendGraph.error')}</Text>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => void refetch()}
                className="rounded-full bg-primary px-4 py-2 web:cursor-pointer"
              >
                <Text style={textStyles.retry}>{t('trendGraph.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : isEmpty ? (
            <EmptyState
              title={t('trendGraph.empty')}
              sticker="trendGraph"
              containerStyle={{ paddingTop: 40 }}
            />
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
        </ScreenScrollView>
      </Screen>
    </>
  );
}

/** A titled block of rows, matching the section headers used across the app. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const textStyles = useTextStyles();
  return (
    <View className="mb-2">
      <View className="px-4 py-2">
        <Text style={textStyles.sectionTitle}>{title}</Text>
      </View>
      <View className="px-4">{children}</View>
    </View>
  );
}

/**
 * A root term with the terms merged into it.
 *
 * The name leads and the measurement follows it on the same line, right
 * aligned. The first version put a long metric sentence ABOVE the name, which
 * inverted the hierarchy — the row's own subject read as its caption — and cost
 * two lines per term.
 */
function Branch({ entry }: { entry: TrendTreeNode }) {
  return (
    <View className="border-border py-1" style={styles.branchBorder}>
      <TermRow
        term={entry.node.term}
        label={entry.node.displayName ?? entry.node.term}
        volume={entry.node.volume}
        authors={entry.node.authorCount}
        emphasis
      />

      {entry.children.length > 0 ? (
        // The trunk: one continuous rule down the left of everything merged into
        // the term above. This is what makes the block read as a tree at a
        // glance rather than as an indent.
        <View className="ml-1 border-border pl-3" style={styles.trunk}>
          {entry.children.map((child) => (
            <TermRow
              key={child.node.term}
              term={child.node.term}
              label={child.node.displayName ?? child.node.term}
              volume={child.node.volume}
              authors={child.node.authorCount}
            />
          ))}
        </View>
      ) : null}

      <RelatedLine entry={entry} />
    </View>
  );
}

/** How many related terms are named before the rest become a count. */
const RELATED_SHOWN = 3;

/**
 * The near misses of a branch, on ONE line.
 *
 * Every unmerged edge used to get its own sentence — "Related to X — N shared
 * posts, not merged" — repeated for the root and for each child. One term
 * produced seven consecutive lines of it and the detail buried the tree it was
 * annotating. The same fact fits in a line: these were related and were not
 * merged, and the exact counts belong on the term's own screen.
 */
function RelatedLine({ entry }: { entry: TrendTreeNode }) {
  const textStyles = useTextStyles();
  const { t } = useTranslation();

  const names = useMemo(() => {
    const seen = new Set<string>();
    const all = [entry, ...entry.children].flatMap((node) => node.related);
    const ordered = [...all].sort((left, right) => right.posts - left.posts);
    const out: string[] = [];
    for (const relation of ordered) {
      if (seen.has(relation.term)) continue;
      seen.add(relation.term);
      out.push(relation.displayName ?? relation.term);
    }
    return out;
  }, [entry]);

  if (names.length === 0) return null;

  const shown = names.slice(0, RELATED_SHOWN);
  const rest = names.length - shown.length;

  return (
    <View className="ml-1 border-border pb-1 pl-3" style={styles.dashedTrunk}>
      <Text style={textStyles.related} numberOfLines={2}>
        {t('trendGraph.related', {
          terms: shown.join(', '),
          count: rest,
        })}
      </Text>
    </View>
  );
}

/**
 * One term: name first, measurement trailing.
 *
 * No chevron. Twenty of them down a screen is twenty repetitions of "this is
 * tappable" — which the row already communicates, and which `TrendItemRow` says
 * with a sparkline or nothing at all.
 */
function TermRow({
  term,
  label,
  volume,
  authors,
  emphasis = false,
}: {
  term: string;
  label: string;
  volume: number;
  authors: number;
  emphasis?: boolean;
}) {
  const textStyles = useTextStyles();
  const { t } = useTranslation();
  const { navigateToTerm } = useTrendNavigation();

  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.7}
      onPress={() => navigateToTerm(term, 'graph')}
      className="web:cursor-pointer flex-row items-baseline justify-between py-1.5"
    >
      <Text
        style={[textStyles.label, emphasis ? textStyles.labelEmphasis : textStyles.labelPlain]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text style={textStyles.counts}>
        {t('trendGraph.node.posts', { count: volume })}
        {' · '}
        {t('trendGraph.node.authors', { count: authors })}
      </Text>
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
  const textStyles = useTextStyles();
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
            className={`web:cursor-pointer rounded-full px-3 py-1.5 ${isActive ? 'bg-primary' : 'bg-muted'}`}
          >
            <Text style={[textStyles.filter, isActive && textStyles.filterActive]}>
              {value ?? allLabel}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Hairline separators, the same weight `TrendItemRow` uses — the app draws
  // lists with rules, not with cards.
  branchBorder: { borderBottomWidth: 0.5 },
  // The trunk a branch hangs from. Solid for merged terms, dashed for the ones
  // that were related and not merged, which is the distinction the screen exists
  // to show.
  trunk: { borderLeftWidth: 1 },
  dashedTrunk: { borderLeftWidth: 1, borderStyle: 'dashed' },
});
