import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FlashList } from '@shopify/flash-list';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { Field } from '@oxy.so/bloom/field';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Search } from '@oxy.so/bloom/search';
import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import type { JobSearchResult } from '@clarity.surf/sdk';
import type { MentionJobEmploymentType, MentionJobWorkplaceType } from '@mention/shared-types';
import {
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_WORKPLACE_TYPES,
} from '@mention/shared-types/job';
import { Error as ErrorState } from '@/components/Error';
import { useSafeBack } from '@/hooks/useSafeBack';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { Storage } from '@/utils/storage';
import { viewerQueryKeys, viewerStorageKey } from '@/lib/viewerQueryKeys';
import { jobsService, type MentionJobDiscoveryFilters } from '@/services/jobsService';
import JobDiscoveryResultCard, { ExternalJobReportSheet } from '@/components/Jobs/JobDiscoveryResultCard';

const WORKPLACE_LABELS: Record<MentionJobWorkplaceType, string> = {
  onsite: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

const EMPLOYMENT_LABELS: Record<MentionJobEmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  temporary: 'Temporary',
  internship: 'Internship',
  other: 'Other',
};

type DatePosted = 'any' | '24h' | '7d' | '30d';

const DATE_POSTED_MS: Record<Exclude<DatePosted, 'any'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface DraftFilters {
  q: string;
  location: string;
  workplaceType: MentionJobWorkplaceType | '';
  employmentType: MentionJobEmploymentType | '';
  salaryMin: string;
  salaryMax: string;
  datePosted: DatePosted;
}

const EMPTY_DRAFT: DraftFilters = {
  q: '',
  location: '',
  workplaceType: '',
  employmentType: '',
  salaryMin: '',
  salaryMax: '',
  datePosted: 'any',
};

function buildDiscoveryFilters(draft: DraftFilters): MentionJobDiscoveryFilters {
  const min = draft.salaryMin.trim() ? Number(draft.salaryMin) : undefined;
  const max = draft.salaryMax.trim() ? Number(draft.salaryMax) : undefined;
  return {
    q: draft.q.trim() || undefined,
    location: draft.location.trim() || undefined,
    workplaceType: draft.workplaceType || undefined,
    employmentType: draft.employmentType || undefined,
    salaryMin: Number.isFinite(min) ? min : undefined,
    salaryMax: Number.isFinite(max) ? max : undefined,
    publishedAfter:
      draft.datePosted === 'any' ? undefined : new Date(Date.now() - DATE_POSTED_MS[draft.datePosted]).toISOString(),
    limit: 20,
  };
}

/** Debounce before a text keystroke (query/location) turns into a request — same rule as `search/index.tsx`. */
const DISCOVERY_DEBOUNCE_MS = 500;

const SAVED_JOBS_STORAGE_KEY = 'mention.jobs.saved';

type DiscoveryRow =
  | { kind: 'filters' }
  | { kind: 'result'; key: string; job: JobSearchResult }
  | { kind: 'status'; key: string; state: 'loading' | 'error' | 'empty' };

/**
 * Global job discovery — `GET /jobs`, the public Clarity-backed search. Mirrors
 * `app/(app)/search/index.tsx`'s established shape: ONE `FlashList` rendering a
 * flattened row union (a filters row, then results, then a loading/error/empty
 * status row) so the scroll container never swaps, and a `setTimeout` ref
 * debounces free-text typing rather than an Effect.
 *
 * "Save" has no backend counterpart in issue #952's contract (only
 * applications do) — it is a lightweight, PER-DEVICE bookmark list in
 * `AsyncStorage`, keyed per viewer like search history and drafts already are.
 */
export default function JobsDiscoveryScreen() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const safeBack = useSafeBack();
  const bottomSheet = useContext(BottomSheetContext);
  const viewerId = user?.id;

  const [draft, setDraft] = useState<DraftFilters>(EMPTY_DRAFT);
  const [committed, setCommitted] = useState<DraftFilters>(EMPTY_DRAFT);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitNow = useCallback((next: DraftFilters) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setCommitted(next);
  }, []);

  const scheduleCommit = useCallback((next: DraftFilters) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      setCommitted(next);
    }, DISCOVERY_DEBOUNCE_MS);
  }, []);

  const handleQueryChange = useCallback(
    (text: string) => {
      const next = { ...draft, q: text };
      setDraft(next);
      scheduleCommit(next);
    },
    [draft, scheduleCommit],
  );

  const handleLocationChange = useCallback(
    (text: string) => {
      const next = { ...draft, location: text };
      setDraft(next);
      scheduleCommit(next);
    },
    [draft, scheduleCommit],
  );

  const handleSalaryChange = useCallback(
    (field: 'salaryMin' | 'salaryMax', text: string) => {
      const next = { ...draft, [field]: text };
      setDraft(next);
      scheduleCommit(next);
    },
    [draft, scheduleCommit],
  );

  // Discrete pickers (chips, date-posted) commit immediately — there is no
  // keystroke to debounce, so waiting would just add a pointless delay.
  const setWorkplaceType = useCallback(
    (value: MentionJobWorkplaceType | '') => {
      const next = { ...draft, workplaceType: value };
      setDraft(next);
      commitNow(next);
    },
    [draft, commitNow],
  );

  const setEmploymentType = useCallback(
    (value: MentionJobEmploymentType | '') => {
      const next = { ...draft, employmentType: value };
      setDraft(next);
      commitNow(next);
    },
    [draft, commitNow],
  );

  const setDatePosted = useCallback(
    (value: DatePosted) => {
      const next = { ...draft, datePosted: value };
      setDraft(next);
      commitNow(next);
    },
    [draft, commitNow],
  );

  const filters = useMemo(() => buildDiscoveryFilters(committed), [committed]);

  const discoveryQuery = useInfiniteQuery({
    queryKey: viewerQueryKeys.jobDiscovery(viewerId, filters),
    queryFn: ({ pageParam }) => jobsService.list({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 60 * 1000,
  });

  const results = useMemo<JobSearchResult[]>(
    () => discoveryQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [discoveryQuery.data],
  );

  const loading = discoveryQuery.isPending || (discoveryQuery.isFetching && !discoveryQuery.isFetchingNextPage);

  // --- Saved jobs (local, per-viewer bookmark list; no backend surface exists for this yet) ---
  const savedStorageKey = useMemo(() => viewerStorageKey(SAVED_JOBS_STORAGE_KEY, viewerId), [viewerId]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  // Reading AsyncStorage is a real external system, which is exactly what an
  // Effect is for — never done during render (a ref-guarded `if` in the
  // render body reads as a one-shot too, but still runs on every render until
  // the promise resolves, which is the pattern this avoids).
  useEffect(() => {
    let cancelled = false;
    void Storage.get<string[]>(savedStorageKey).then((ids) => {
      if (!cancelled && ids) setSavedIds(new Set(ids));
    });
    return () => {
      cancelled = true;
    };
  }, [savedStorageKey]);

  const toggleSave = useCallback(
    (job: JobSearchResult) => {
      setSavedIds((prev) => {
        const next = new Set(prev);
        const willSave = !next.has(job.id);
        if (willSave) next.add(job.id);
        else next.delete(job.id);
        void Storage.set(savedStorageKey, Array.from(next));
        toast(
          willSave
            ? t('jobs.discovery.saved', { defaultValue: 'Job saved' })
            : t('jobs.discovery.unsaved', { defaultValue: 'Removed from saved' }),
          { type: 'success' },
        );
        return next;
      });
    },
    [savedStorageKey, t],
  );

  const reportJob = useCallback(
    (job: JobSearchResult) => {
      bottomSheet.setBottomSheetContent(
        <ExternalJobReportSheet clarityJobId={job.id} onClose={() => bottomSheet.openBottomSheet(false)} />,
      );
      bottomSheet.openBottomSheet(true);
    },
    [bottomSheet],
  );

  const handleEndReached = useCallback(() => {
    if (discoveryQuery.hasNextPage && !discoveryQuery.isFetchingNextPage) {
      void discoveryQuery.fetchNextPage();
    }
  }, [discoveryQuery]);

  const rows = useMemo<DiscoveryRow[]>(() => {
    const out: DiscoveryRow[] = [{ kind: 'filters' }];
    if (loading) {
      out.push({ kind: 'status', key: 'status-loading', state: 'loading' });
      return out;
    }
    if (discoveryQuery.isError) {
      out.push({ kind: 'status', key: 'status-error', state: 'error' });
      return out;
    }
    if (results.length === 0) {
      out.push({ kind: 'status', key: 'status-empty', state: 'empty' });
      return out;
    }
    for (const job of results) {
      out.push({ kind: 'result', key: job.id, job });
    }
    return out;
  }, [loading, discoveryQuery.isError, results]);

  const renderRow = useCallback(
    ({ item }: { item: DiscoveryRow }) => {
      if (item.kind === 'filters') {
        return (
          <View className="px-4 pt-3 pb-2 gap-3">
            <Search
              label={t('jobs.discovery.searchPlaceholder', { defaultValue: 'Search jobs' })}
              value={draft.q}
              onChangeText={handleQueryChange}
              onClearText={() => handleQueryChange('')}
              onSubmitEditing={() => commitNow(draft)}
            />
            <TextField>
              <TextFieldInput
                label={t('jobs.discovery.location', { defaultValue: 'Location' })}
                value={draft.location}
                onChangeText={handleLocationChange}
              />
            </TextField>

            <Button
              variant="text"
              size="small"
              onPress={() => setShowMoreFilters((v) => !v)}
              style={{ alignSelf: 'flex-start' }}
            >
              {showMoreFilters
                ? t('jobs.discovery.hideFilters', { defaultValue: 'Hide filters' })
                : t('jobs.discovery.moreFilters', { defaultValue: 'More filters' })}
            </Button>

            {showMoreFilters ? (
              <View className="gap-3">
                <Field label={t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })} multiple>
                  <View className="flex-row flex-wrap gap-2">
                    {MENTION_JOB_WORKPLACE_TYPES.map((value) => (
                      <Chip
                        key={value}
                        selected={draft.workplaceType === value}
                        onPress={() => setWorkplaceType(draft.workplaceType === value ? '' : value)}
                      >
                        {WORKPLACE_LABELS[value]}
                      </Chip>
                    ))}
                  </View>
                </Field>

                <Field label={t('jobs.create.employmentType', { defaultValue: 'Employment type' })} multiple>
                  <View className="flex-row flex-wrap gap-2">
                    {MENTION_JOB_EMPLOYMENT_TYPES.map((value) => (
                      <Chip
                        key={value}
                        selected={draft.employmentType === value}
                        onPress={() => setEmploymentType(draft.employmentType === value ? '' : value)}
                      >
                        {EMPLOYMENT_LABELS[value]}
                      </Chip>
                    ))}
                  </View>
                </Field>

                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <TextField>
                      <TextFieldInput
                        label={t('jobs.create.salaryMin', { defaultValue: 'Min salary' })}
                        value={draft.salaryMin}
                        onChangeText={(v) => handleSalaryChange('salaryMin', v)}
                        keyboardType="numeric"
                      />
                    </TextField>
                  </View>
                  <View className="flex-1">
                    <TextField>
                      <TextFieldInput
                        label={t('jobs.create.salaryMax', { defaultValue: 'Max salary' })}
                        value={draft.salaryMax}
                        onChangeText={(v) => handleSalaryChange('salaryMax', v)}
                        keyboardType="numeric"
                      />
                    </TextField>
                  </View>
                </View>

                <Field label={t('jobs.discovery.datePosted', { defaultValue: 'Date posted' })}>
                  <SegmentedControl
                    label={t('jobs.discovery.datePosted', { defaultValue: 'Date posted' })}
                    type="radio"
                    size="small"
                    value={draft.datePosted}
                    onChange={setDatePosted}
                  >
                    <SegmentedControlItem value="any">
                      <SegmentedControlItemText>{t('jobs.discovery.anyTime', { defaultValue: 'Any time' })}</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="24h">
                      <SegmentedControlItemText>{t('jobs.discovery.past24h', { defaultValue: 'Past 24h' })}</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="7d">
                      <SegmentedControlItemText>{t('jobs.discovery.pastWeek', { defaultValue: 'Past week' })}</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="30d">
                      <SegmentedControlItemText>{t('jobs.discovery.pastMonth', { defaultValue: 'Past month' })}</SegmentedControlItemText>
                    </SegmentedControlItem>
                  </SegmentedControl>
                </Field>
              </View>
            ) : null}
          </View>
        );
      }

      if (item.kind === 'result') {
        return (
          <JobDiscoveryResultCard
            job={item.job}
            isSaved={savedIds.has(item.job.id)}
            onToggleSave={toggleSave}
            onReport={reportJob}
          />
        );
      }

      // status row
      if (item.state === 'loading') {
        return (
          <View className="items-center justify-center py-16">
            <Loading className="text-primary" size="large" />
          </View>
        );
      }
      if (item.state === 'error') {
        return (
          <ErrorState
            title={t('jobs.discovery.errorTitle', { defaultValue: 'Could not load jobs' })}
            message={t('jobs.discovery.errorMessage', { defaultValue: 'Check your connection and try again.' })}
            onRetry={() => void discoveryQuery.refetch()}
            hideBackButton
          />
        );
      }
      return (
        <View className="items-center justify-center py-16 px-8 gap-2">
          <Text className="text-foreground text-base font-semibold text-center">
            {t('jobs.discovery.emptyTitle', { defaultValue: 'No jobs found' })}
          </Text>
          <Text className="text-muted-foreground text-sm text-center">
            {t('jobs.discovery.emptySubtitle', { defaultValue: 'Try a different search or clear a filter.' })}
          </Text>
        </View>
      );
    },
    [
      t,
      draft,
      showMoreFilters,
      handleQueryChange,
      handleLocationChange,
      handleSalaryChange,
      setWorkplaceType,
      setEmploymentType,
      setDatePosted,
      commitNow,
      savedIds,
      toggleSave,
      reportJob,
      discoveryQuery,
    ],
  );

  const keyExtractor = useCallback((item: DiscoveryRow) => (item.kind === 'filters' ? 'filters' : item.key), []);
  const getItemType = useCallback((item: DiscoveryRow) => item.kind, []);

  return (
    <View className="flex-1">
      <PageHeader
        title={t('jobs.discovery.title', { defaultValue: 'Jobs' })}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      <View className="flex-1 min-h-0">
        <FlashList
          data={rows}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            discoveryQuery.isFetchingNextPage ? (
              <View className="items-center justify-center py-4">
                <Loading className="text-primary" size="small" />
              </View>
            ) : null
          }
        />
      </View>
    </View>
  );
}
