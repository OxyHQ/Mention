import { Storage } from '@/utils/storage';
import {
  viewerStorageKey,
  type ViewerId,
} from '@/lib/viewerQueryKeys';
import { createKeyedAsyncQueue } from '@/lib/keyedAsyncQueue';

const LEGACY_RECOMMENDATION_FILTERS_KEY = '@mention/recommendation_filters';
const RECOMMENDATION_FILTERS_KEY = '@mention/recommendation_filters:v2';

export interface RecommendationFilters {
  showFederated: boolean;
  showAgents: boolean;
  showAutomated: boolean;
}

export const DEFAULT_RECOMMENDATION_FILTERS: RecommendationFilters = {
  showFederated: true,
  showAgents: true,
  showAutomated: true,
};

const viewerEpochs = new Map<string, number>();
const enqueueRecommendationStorage = createKeyedAsyncQueue();

function normalizePrivateViewerId(viewerId: ViewerId): string | null {
  const normalized = viewerId?.trim();
  return normalized || null;
}

export function getRecommendationFiltersStorageKey(viewerId: string): string {
  return viewerStorageKey(RECOMMENDATION_FILTERS_KEY, viewerId);
}

function currentEpoch(viewerId: string): number {
  return viewerEpochs.get(viewerId) ?? 0;
}

function removeLegacyRecommendationFilters(): void {
  // The v1 payload has no owner. Never migrate it to whichever account happens
  // to authenticate first on a shared device.
  void Storage.remove(LEGACY_RECOMMENDATION_FILTERS_KEY).catch(() => {});
}

export async function getRecommendationFilters(
  viewerId: ViewerId = undefined,
): Promise<RecommendationFilters> {
  const normalizedViewerId = normalizePrivateViewerId(viewerId);
  if (!normalizedViewerId) return DEFAULT_RECOMMENDATION_FILTERS;

  removeLegacyRecommendationFilters();
  const operationEpoch = currentEpoch(normalizedViewerId);
  const stored = await enqueueRecommendationStorage(
    normalizedViewerId,
    async () => {
      if (operationEpoch !== currentEpoch(normalizedViewerId)) {
        return null;
      }
      return Storage.get<Partial<RecommendationFilters>>(
        getRecommendationFiltersStorageKey(normalizedViewerId),
      );
    },
  );
  if (operationEpoch !== currentEpoch(normalizedViewerId)) {
    return DEFAULT_RECOMMENDATION_FILTERS;
  }
  return stored
    ? { ...DEFAULT_RECOMMENDATION_FILTERS, ...stored }
    : DEFAULT_RECOMMENDATION_FILTERS;
}

export async function saveRecommendationFilters(
  filters: RecommendationFilters,
  viewerId: ViewerId,
): Promise<void> {
  const normalizedViewerId = normalizePrivateViewerId(viewerId);
  if (!normalizedViewerId) return;

  removeLegacyRecommendationFilters();
  const operationEpoch = currentEpoch(normalizedViewerId);
  const storageKey = getRecommendationFiltersStorageKey(normalizedViewerId);
  await enqueueRecommendationStorage(normalizedViewerId, async () => {
    if (operationEpoch !== currentEpoch(normalizedViewerId)) return;
    await Storage.set(storageKey, filters);
  });
}

/** Invalidate pending work and erase the previous viewer's local preferences. */
export function resetRecommendationFiltersViewer(viewerId: ViewerId): void {
  const normalizedViewerId = normalizePrivateViewerId(viewerId);
  if (!normalizedViewerId) return;

  viewerEpochs.set(
    normalizedViewerId,
    currentEpoch(normalizedViewerId) + 1,
  );
  removeLegacyRecommendationFilters();
  void enqueueRecommendationStorage(
    normalizedViewerId,
    () => Storage.remove(
      getRecommendationFiltersStorageKey(normalizedViewerId),
    ),
  )
    .catch(() => {});
}
