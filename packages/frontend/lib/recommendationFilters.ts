import { Storage } from '@/utils/storage';

const RECOMMENDATION_FILTERS_KEY = '@mention/recommendation_filters';

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

let cached: RecommendationFilters | null = null;

export async function getRecommendationFilters(): Promise<RecommendationFilters> {
  if (cached) return cached;
  const stored = await Storage.get<Partial<RecommendationFilters>>(RECOMMENDATION_FILTERS_KEY);
  cached = stored ? { ...DEFAULT_RECOMMENDATION_FILTERS, ...stored } : DEFAULT_RECOMMENDATION_FILTERS;
  return cached;
}

export async function saveRecommendationFilters(filters: RecommendationFilters): Promise<void> {
  cached = filters;
  await Storage.set(RECOMMENDATION_FILTERS_KEY, filters);
}
