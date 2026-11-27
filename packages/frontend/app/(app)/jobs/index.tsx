import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import type { JobSearchResult } from '@mention/shared-types/job';
import type { MentionJobEmploymentType, MentionJobWorkplaceType } from '@mention/shared-types';
import {
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_WORKPLACE_TYPES,
} from '@mention/shared-types/job';
import { Error as ErrorState } from '@/components/Error';
import { presentSheet } from '@/utils/sheet';
import { Storage } from '@/utils/storage';
import { viewerQueryKeys, viewerStorageKey } from '@/lib/viewerQueryKeys';
import { getNextJobPage } from '@/lib/jobPagination';
import { jobsService, type MentionJobDiscoveryFilters } from '@/services/jobsService';
import JobDiscoveryResultCard, {
  ExternalJobReportSheet,
} from '@/components/Jobs/JobDiscoveryResultCard';
import { EmptyState } from '@/components/common/EmptyState';
import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Text,
  VStack,
  toElement,
  Embed as LEmbed,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';
import { Chip as LChip } from '@oxy.so/bloom-language/containers';
import {
  Field as LField,
  Option,
  Search as LSearch,
  Segmented,
  TextField as LTextField,
} from '@oxy.so/bloom-language/inputs';
import { VirtualList as LVirtualList } from '@oxy.so/bloom-language/list';

import { screen as Lscreen } from '@oxy.so/bloom-language/router';

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
      draft.datePosted === 'any'
        ? undefined
        : new Date(Date.now() - DATE_POSTED_MS[draft.datePosted]).toISOString(),
    limit: 20,
  };
}

/** Debounce before a text keystroke (query/location) turns into a request — same rule as `search/index.tsx`. */
const DISCOVERY_DEBOUNCE_MS = 500;

const SAVED_JOBS_STORAGE_KEY = 'mention.jobs.saved';

type DiscoveryRow =
  | { kind: 'result'; key: string; job: JobSearchResult }
  | { kind: 'status'; key: string; state: 'loading' | 'error' | 'empty' };

/**
 * Global job discovery — `GET /jobs`, the public Clarity-backed search. ONE
 * Bloom `VirtualList` renders the filters as its header and a flattened row
 * union (results, or a loading/error/empty status row) so the scroll container
 * never swaps, and a `setTimeout` ref debounces free-text typing rather than an
 * Effect.
 *
 * It is a `VirtualList`, not a `FlashList`: on web the document is the scroller,
 * so a FlashList here had no bounded height, mounted every row and kept firing
 * `onEndReached` — the screen paged through the whole index on its own, about a
 * page a second, until the tab ran out of memory. It pages from `onEndReached`
 * on both platforms.
 *
 * "Save" has no backend counterpart in issue #952's contract (only
 * applications do) — it is a lightweight, PER-DEVICE bookmark list in
 * `AsyncStorage`, keyed per viewer like search history and drafts already are.
 */
export default Lscreen(function JobsDiscoveryScreen() {
  const { t } = useTranslation();
  const { user } = useAuth();
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
    getNextPageParam: getNextJobPage,
    staleTime: 60 * 1000,
  });

  const results = useMemo<JobSearchResult[]>(
    () => discoveryQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [discoveryQuery.data],
  );

  const loading =
    discoveryQuery.isPending || (discoveryQuery.isFetching && !discoveryQuery.isFetchingNextPage);

  // --- Saved jobs (local, per-viewer bookmark list; no backend surface exists for this yet) ---
  const savedStorageKey = useMemo(
    () => viewerStorageKey(SAVED_JOBS_STORAGE_KEY, viewerId),
    [viewerId],
  );
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

  const reportJob = useCallback((job: JobSearchResult) => {
    void presentSheet((surface) => (
      <ExternalJobReportSheet clarityJobId={job.id} onClose={() => surface.dismiss()} />
    ));
  }, []);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = discoveryQuery;
  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = useMemo<DiscoveryRow[]>(() => {
    const out: DiscoveryRow[] = [];
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

  const filtersHeader = toElement(
    VStack(
      LSearch([draft.q, handleQueryChange])
        .label(t('jobs.discovery.searchPlaceholder', { defaultValue: 'Search jobs' }))
        .onClearText(() => handleQueryChange(''))
        .onSubmit(() => commitNow(draft)),
      LTextField(
        [draft.location, handleLocationChange],
        t('jobs.discovery.location', { defaultValue: 'Location' }),
      ),
      LButton(
        Text(
          showMoreFilters
            ? t('jobs.discovery.hideFilters', { defaultValue: 'Hide filters' })
            : t('jobs.discovery.moreFilters', { defaultValue: 'More filters' }),
        ),
      )
        .style('plain')
        .tint('accent')
        .size('sm')
        .alignSelf('start')
        .onPress(() => setShowMoreFilters((v) => !v)),
      showMoreFilters
        ? VStack(
            Embed(
              LtoElement(
                LField(
                  t('jobs.create.workplaceType', { defaultValue: 'Workplace type' }),
                  LEmbed(
                    toElement(
                      HStack(
                        Embed(
                          MENTION_JOB_WORKPLACE_TYPES.map((value) =>
                            toElement(
                              LChip(Text(WORKPLACE_LABELS[value]))
                                .selected(draft.workplaceType === value)
                                .onPress(() =>
                                  setWorkplaceType(draft.workplaceType === value ? '' : value),
                                ),
                              value,
                            ),
                          ),
                        ),
                      )
                        .wrap()
                        .spacing('sm'),
                    ),
                  ),
                ).multiple(),
              ),
            ),
            Embed(
              LtoElement(
                LField(
                  t('jobs.create.employmentType', { defaultValue: 'Employment type' }),
                  LEmbed(
                    toElement(
                      HStack(
                        Embed(
                          MENTION_JOB_EMPLOYMENT_TYPES.map((value) =>
                            toElement(
                              LChip(Text(EMPLOYMENT_LABELS[value]))
                                .selected(draft.employmentType === value)
                                .onPress(() =>
                                  setEmploymentType(draft.employmentType === value ? '' : value),
                                ),
                              value,
                            ),
                          ),
                        ),
                      )
                        .wrap()
                        .spacing('sm'),
                    ),
                  ),
                ).multiple(),
              ),
            ),
            HStack(
              VStack(
                LTextField(
                  [draft.salaryMin, (v) => handleSalaryChange('salaryMin', v)],
                  t('jobs.create.salaryMin', { defaultValue: 'Min salary' }),
                ).keyboard('numeric'),
              ).flex('1'),
              VStack(
                LTextField(
                  [draft.salaryMax, (v) => handleSalaryChange('salaryMax', v)],
                  t('jobs.create.salaryMax', { defaultValue: 'Max salary' }),
                ).keyboard('numeric'),
              ).flex('1'),
            ).spacing('sm'),
            LField(
              t('jobs.discovery.datePosted', { defaultValue: 'Date posted' }),
              Segmented(
                [draft.datePosted, setDatePosted],
                Option('any', t('jobs.discovery.anyTime', { defaultValue: 'Any time' })),
                Option('24h', t('jobs.discovery.past24h', { defaultValue: 'Past 24h' })),
                Option('7d', t('jobs.discovery.pastWeek', { defaultValue: 'Past week' })),
                Option('30d', t('jobs.discovery.pastMonth', { defaultValue: 'Past month' })),
              )
                .label(t('jobs.discovery.datePosted', { defaultValue: 'Date posted' }))
                .size('sm'),
            ),
          ).spacing('md')
        : null,
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .spacing('md'),
  );

  const renderRow = useCallback(
    ({ item }: { item: DiscoveryRow }) => {
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
        return <ListSkeleton />;
      }
      if (item.state === 'error') {
        return (
          <ErrorState
            title={t('jobs.discovery.errorTitle', { defaultValue: 'Could not load jobs' })}
            message={t('jobs.discovery.errorMessage', {
              defaultValue: 'Check your connection and try again.',
            })}
            onRetry={() => void discoveryQuery.refetch()}
            hideBackButton
          />
        );
      }
      return (
        <EmptyState
          title={t('jobs.discovery.emptyTitle', { defaultValue: 'No jobs found' })}
          subtitle={t('jobs.discovery.emptySubtitle', {
            defaultValue: 'Try a different search or clear a filter.',
          })}
          sticker="jobsSearch"
          containerStyle={{ paddingTop: 40 }}
        />
      );
    },
    [t, savedIds, toggleSave, reportJob, discoveryQuery],
  );

  const keyExtractor = useCallback((item: DiscoveryRow) => item.key, []);

  return LVirtualList(rows, renderRow)
    .screen()
    .itemKey(keyExtractor)
    .headerContent(Embed(filtersHeader))
    .onEndReached(handleEndReached, 0.5)
    .footerContent(
      VStack(Embed(isFetchingNextPage ? <ListSkeleton count={2} /> : null))
        .padding('vertical', 'lg')
        .align('center')
        .justify('center'),
    )
    .header(
      Header(t('jobs.discovery.title', { defaultValue: 'Jobs' }))
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .inPage(),
    );
});
